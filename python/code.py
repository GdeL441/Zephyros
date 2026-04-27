import time
import json
import wifi
import socketpool
from adafruit_httpserver import Server, Request, Response, Websocket, GET
import asyncio
import board
import digitalio
import analogio
import math
import busio
import struct
import errno  # Added for precise I2C error parsing

# ── I2C / DimmerLink ──────────────────────────────────────────────────────────
_DIMMER_SDA_PIN = board.GP20
_DIMMER_SCL_PIN = board.GP21
_DIMMER_ADDR    = 0x50

_REG_STATUS  = 0x00
_REG_COMMAND = 0x01
_REG_ERROR   = 0x02
_REG_LEVEL   = 0x10
_REG_CURVE   = 0x11
_REG_FREQ    = 0x20

_DIMMER_READ_INTERVAL_S = 0.1
_DIMMER_MAX_FAILURES    = 3
_I2C_LOCK_TIMEOUT       = 50

# Helper to decode opaque CircuitPython OSErrors
def _decode_i2c_error(e: OSError) -> str:
    if hasattr(e, 'errno'):
        if e.errno == 19: return "ENODEV (19) - No device. Check power, address, or physical connection."
        if e.errno == 5:  return "EIO (5) - Bus error. Usually electrical noise or NACK mid-transmission."
        if e.errno == 116: return "ETIMEDOUT (116) - Bus hung. Missing pull-up resistors or slave is clock-stretching infinitely."
    return str(e)

def _dimmer_i2c_init() -> busio.I2C | None:
    try:
        # Reduced frequency from 100k to 50k. Custom/ATtiny slaves often
        # struggle with 100kHz while servicing zero-cross interrupts.
        bus = busio.I2C(scl=_DIMMER_SCL_PIN, sda=_DIMMER_SDA_PIN, frequency=50_000)
        print("DimmerLink I2C initialised")
        return bus
    except RuntimeError as e:
        print(f"DimmerLink I2C init failed: {e}")
        return None

dimmer_i2c = _dimmer_i2c_init()

# ── DimmerLink state ──────────────────────────────────────────────────────────
target_fan_speed            = 0
current_fan_speed           = 0
_last_sent_speed            = 0
_last_percent_poll_s        = 0.0
_last_known_dimmer_percent  = 0
_consecutive_write_failures = 0
_speed_event                = asyncio.Event()

def set_target_fan_speed(percent: int) -> None:
    global target_fan_speed, current_fan_speed
    percent = max(0, min(100, int(percent)))
    target_fan_speed      = percent
    current_fan_speed     = percent
    _speed_event.set()

# ── DimmerLink I2C helpers ────────────────────────────────────────────────────

async def _dimmer_reinit() -> None:
    """Tear down and recreate the DimmerLink I2C bus safely."""
    global dimmer_i2c
    if dimmer_i2c is not None:
        # Wait for the bus to unlock so we don't crash active background reads
        retries = 10
        while not dimmer_i2c.try_lock() and retries > 0:
            await asyncio.sleep(0.01)
            retries -= 1
        try:
            dimmer_i2c.deinit()
        except Exception:
            pass
    await asyncio.sleep(0.050)
    dimmer_i2c = _dimmer_i2c_init()

async def _dimmer_read_reg(reg: int) -> int | None:
    if dimmer_i2c is None:
        return None
    result = bytearray(1)
    retries = _I2C_LOCK_TIMEOUT
    while not dimmer_i2c.try_lock():
        retries -= 1
        if retries <= 0:
            print("DimmerLink: I2C bus lock timeout (read)")
            return None
        await asyncio.sleep(0.010)
    try:
        dimmer_i2c.writeto_then_readfrom(_DIMMER_ADDR, bytes([reg]), result)
        return result[0]
    except OSError as e:
        print(f"DimmerLink: read reg 0x{reg:02X} failed — {_decode_i2c_error(e)}")
        return None
    finally:
        dimmer_i2c.unlock()

async def _dimmer_write_reg(reg: int, value: int) -> bool:
    if dimmer_i2c is None:
        return False
    retries = _I2C_LOCK_TIMEOUT
    while not dimmer_i2c.try_lock():
        retries -= 1
        if retries <= 0:
            print("DimmerLink: I2C bus lock timeout (write)")
            return False
        await asyncio.sleep(0.010)
    try:
        dimmer_i2c.writeto(_DIMMER_ADDR, bytes([reg, value]))
        return True
    except OSError as e:
        print(f"DimmerLink: write reg 0x{reg:02X}=0x{value:02X} failed — {_decode_i2c_error(e)}")
        return False
    finally:
        dimmer_i2c.unlock()

async def _dimmer_set_level(speed: int) -> bool:
    speed = max(0, min(100, int(speed)))
    return await _dimmer_write_reg(_REG_LEVEL, speed)

# ── DimmerLink background task ────────────────────────────────────────────────

async def dimmer_updater() -> None:
    global _last_sent_speed, _last_known_dimmer_percent, _consecutive_write_failures
    await asyncio.sleep(0.5) 

    while True:
        if target_fan_speed == _last_sent_speed:
            _speed_event.clear()
            await _speed_event.wait()
            continue

        speed = target_fan_speed
        ok = await _dimmer_set_level(speed)

        if ok:
            _consecutive_write_failures = 0
            _last_sent_speed = speed
            _last_known_dimmer_percent = speed
            print(f"DimmerLink: set to {speed}%")
        else:
            _consecutive_write_failures += 1
            backoff = min(0.050 * _consecutive_write_failures, 0.500)
            print(f"DimmerLink: write failed (attempt {_consecutive_write_failures}), backing off {backoff:.3f}s")
            await asyncio.sleep(backoff)

            if _consecutive_write_failures >= _DIMMER_MAX_FAILURES:
                print("DimmerLink: hard recovery — reinitialising I2C bus")
                await _dimmer_reinit()
                _consecutive_write_failures = 0

                if dimmer_i2c is not None:
                    await asyncio.sleep(0.300)
                    await _dimmer_write_reg(_REG_COMMAND, 0x01)
                    await asyncio.sleep(0.100)
                else:
                    print("DimmerLink: reinit failed — backing off 2s")
                    await asyncio.sleep(2.0)

async def get_dimmer_percent() -> int:
    global _last_percent_poll_s, _last_known_dimmer_percent

    now = time.monotonic()
    if (now - _last_percent_poll_s) < _DIMMER_READ_INTERVAL_S:
        return _last_known_dimmer_percent

    val = await _dimmer_read_reg(_REG_LEVEL)
    if val is not None:
        # Fuzzy match to compensate for the hardware's 8-bit rounding errors.
        # If the readback is within 1% of what we asked for, display our target value.
        if abs(val - _last_sent_speed) <= 1:
            _last_known_dimmer_percent = _last_sent_speed
        else:
            _last_known_dimmer_percent = val
            
    _last_percent_poll_s = now
    return _last_known_dimmer_percent

async def calibrate_dimmerlink():
    pass

async def reset_dimmerlink():
    pass    

# ── I2C & SDP810 setup ────────────────────────────────────────────────────────
try:
    i2c = busio.I2C(scl=board.GP27, sda=board.GP26, frequency=100_000)
except RuntimeError as e:
    print(f"I2C init failed: {e}")
    i2c = None

SDP810_ADDR       = 0x25
CMD_START_AVG     = bytes([0x36, 0x15])
CMD_STOP          = bytes([0x3F, 0xF9])
_sdp810_buf       = bytearray(9)
_sdp810_running   = False
_sdp810_available = False

def _crc8(data: bytes) -> int:
    crc = 0xFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x31) if (crc & 0x80) else (crc << 1)
            crc &= 0xFF
    return crc

# Made async to prevent blocking the entire event loop
async def _sdp810_write(cmd: bytes):
    if i2c is None:
        raise OSError("I2C not initialised")
    while not i2c.try_lock():
        await asyncio.sleep(0.01) # Yield to event loop instead of passing
    try:
        i2c.writeto(SDP810_ADDR, cmd)
    finally:
        i2c.unlock()

async def sdp810_start():
    global _sdp810_running, _sdp810_available
    try:
        await _sdp810_write(CMD_START_AVG)
        _sdp810_running = True
        _sdp810_available = True
        await asyncio.sleep(0.020) # Replaced time.sleep with asyncio.sleep
        print("SDP810 ready")
    except (RuntimeError, OSError) as e:
        print(f"SDP810 not found, running without sensor: {_decode_i2c_error(e)}")
        _sdp810_available = False

async def sdp810_stop():
    global _sdp810_running
    await _sdp810_write(CMD_STOP)
    _sdp810_running = False

# Made async to prevent blocking
async def sdp810_read() -> tuple:
    while not i2c.try_lock():
        await asyncio.sleep(0.01)
    try:
        i2c.readfrom_into(SDP810_ADDR, _sdp810_buf)
    finally:
        i2c.unlock()

    if _crc8(_sdp810_buf[0:2]) != _sdp810_buf[2]: raise ValueError("SDP810 CRC fail: pressure bytes")
    if _crc8(_sdp810_buf[3:5]) != _sdp810_buf[5]: raise ValueError("SDP810 CRC fail: temperature bytes")
    if _crc8(_sdp810_buf[6:8]) != _sdp810_buf[8]: raise ValueError("SDP810 CRC fail: scale factor bytes")

    raw_pressure  = struct.unpack(">h", _sdp810_buf[0:2])[0]
    raw_temp      = struct.unpack(">h", _sdp810_buf[3:5])[0]
    scale_factor  = struct.unpack(">h", _sdp810_buf[6:8])[0]

    pressure_pa    = raw_pressure  / scale_factor
    temperature_c  = raw_temp      / 200.0
    return pressure_pa, temperature_c

# ── ADC / Voltage sensing ─────────────────────────────────────────────────────
_ADC_PIN          = board.GP28        # ADC2
_ADC_REF_V        = 3.3
_ADC_MAX          = 65535
_ADC_ALPHA        = 0.2               # EMA smoothing factor (0-1, lower = smoother)
_adc              = analogio.AnalogIn(_ADC_PIN)
smoothed_voltage  = 0.0               # Volts, updated at 20 Hz

async def adc_sampler():
    """Read ADC2 at 20 Hz and apply exponential moving average."""
    global smoothed_voltage
    # Seed with the first reading so the EMA doesn't ramp from zero
    smoothed_voltage = (_adc.value / _ADC_MAX) * _ADC_REF_V
    while True:
        raw_v = (_adc.value / _ADC_MAX) * _ADC_REF_V
        smoothed_voltage = _ADC_ALPHA * raw_v + (1 - _ADC_ALPHA) * smoothed_voltage
        await asyncio.sleep(0.05)     # 20 Hz

# ── Air data ──────────────────────────────────────────────────────────────────
shunt_value = 4700 # Ohms
R_SPECIFIC = 287.05
smoothed_airspeed_ms = 0
current_temperate = 15
current_pressure = 101325
air_density = current_pressure / (R_SPECIFIC * (current_temperate + 273.15))

Kp = 0
Ki = 0
Kd = 0

SSID = "Zephyros"
PASSWORD = "password"
PORT = 80

led = digitalio.DigitalInOut(board.LED)
led.direction = digitalio.Direction.OUTPUT

print("Creating access point...")
wifi.radio.start_ap(ssid=SSID, password=PASSWORD)
print("Access point started. IP:", wifi.radio.ipv4_address_ap)

pool = socketpool.SocketPool(wifi.radio)
server = Server(pool, "/static", debug=True)

current_websocket = None
last_message_time = 0
MIN_MESSAGE_INTERVAL = 0.05

@server.route("/")
def index(request: Request):
    return Response(request, open("/static/index.html").read(), content_type="text/html")

@server.route("/static/<path>")
def static_files(request: Request, path: str):
    return Response.from_file(request, f"/static/{path}")

async def blink(count, on_time=0.1, off_time=0.1):
    for _ in range(count):
        led.value = True
        await asyncio.sleep(on_time)
        led.value = False
        await asyncio.sleep(off_time)

@server.route("/ws", GET)
def ws_handler(request: Request):
    global current_websocket
    websocket = Websocket(request)
    current_websocket = websocket
    # Start at 0% — wait for explicit set_fan_speed from client
    set_target_fan_speed(0)
    print("WebSocket client connected")
    asyncio.create_task(blink(2))
    return websocket

def _on_websocket_disconnect():
    """Safety: turn off the fan when the control link is lost."""
    set_target_fan_speed(0)
    print("Fan set to 0% (WebSocket disconnected)")

async def handle_websocket_message(message):
    global Kp, Ki, Kd, shunt_value, air_density, current_fan_speed
    try:
        data = json.loads(message)
        print(data)

        if data.get('action') == 'reset_dps':
            await sdp810_stop()
            await asyncio.sleep(0.05)
            await sdp810_start()
            print("SDP810 re-started (self-zero applied)")
        elif data.get('action') == 'send_settings':
            await send_current_settings()
        elif data.get('action') == 'set_fan_speed':
            speed = data.get('speed', current_fan_speed)
            current_fan_speed = speed
            set_target_fan_speed(speed)
        elif data.get('action') == "send_data":
            await send_plotting_data()
        elif data.get('action') == 'new_settings':
            Kp = data.get('Kp', Kp)
            Ki = data.get('Ki', Ki)
            Kd = data.get('Kd', Kd)
            shunt_value = data.get('shunt_value', shunt_value)
            air_density = data.get('air_density', air_density)
            await asyncio.sleep(0.1)
            await send_current_settings()
        elif data.get('action') == 'reset_dimmerlink':
            await reset_dimmerlink()
        elif data.get('action') == 'calibrate_dimmerlink':
            await calibrate_dimmerlink()
        else:
            print("Unknown action:", data.get('action'))
            

    except Exception as e:
        print("Error handling WebSocket message:", e)

async def send_websocket_message(data, important=False):
    global current_websocket, last_message_time
    if current_websocket is None:
        return False
    current_time = time.monotonic()
    if not important and (current_time - last_message_time < MIN_MESSAGE_INTERVAL):
        return False
    try:
        current_websocket.send_message(json.dumps(data))
        last_message_time = current_time
        return True
    except Exception as e:
        print("Error sending message:", e)
        current_websocket = None
        _on_websocket_disconnect()
        return False

async def handle_websockets():
    global current_websocket
    while True:
        if current_websocket is not None:
            try:
                data = current_websocket.receive()
                if data:
                    await handle_websocket_message(data)
            except Exception as e:
                print(f"WebSocket error: {e}")
                current_websocket = None
                _on_websocket_disconnect()
                asyncio.create_task(blink(3, on_time=0.05, off_time=0.05))
        await asyncio.sleep(0)

async def run_server():
    server.start(str(wifi.radio.ipv4_address_ap), PORT)
    print(f"Server running on http://{wifi.radio.ipv4_address_ap}:{PORT}")
    while True:
        try:
            server.poll()
        except Exception as e:
            print("Server poll error:", e)
        await asyncio.sleep(0)

async def sensor_broadcaster():
    while True:
        if current_websocket:
            voltage = smoothed_voltage
            power_mw = (voltage ** 2 / shunt_value) * 1000 if shunt_value else 0
            telemetry = {
                "type":       "telemetry",
                "voltage":    round(voltage, 4),
                "resistance": shunt_value,
                "power":      round(power_mw, 4),
                "air_speed":  smoothed_airspeed_ms,
                "fan_speed":  await get_dimmer_percent(),
                "uptime":     time.monotonic(),
            }
            await send_websocket_message(telemetry)
        await asyncio.sleep(0.1)

async def send_current_settings():
    if current_websocket:
        settings = {
            "type":           "settings",
            "Kp":             Kp,
            "Ki":             Ki,
            "Kd":             Kd,
            "shunt_value":    shunt_value,
            "air_density":    air_density,
        }
        await send_websocket_message(settings)

async def send_plotting_data():
    if current_websocket:
        data = { 
            "type": "plot_data",
            "airspeed": smoothed_airspeed_ms,
            "power": round((smoothed_voltage ** 2 / shunt_value) * 1000, 4) if shunt_value else 0,
        }
        await send_websocket_message(data)

async def measure_airspeed():
    global smoothed_airspeed_ms, air_density, current_temperate

    while True:
        if _sdp810_available:
            try:
                pressure_pa, temperature_c = await sdp810_read()
                current_temperate = temperature_c
                air_density = current_pressure / (R_SPECIFIC * (temperature_c + 273.15))
                if pressure_pa <= 0:
                    smoothed_airspeed_ms = -1 * math.sqrt((2.0 * abs(pressure_pa)) / air_density)
                else:
                    smoothed_airspeed_ms = math.sqrt((2.0 * pressure_pa) / air_density)
            except ValueError as e:
                print(f"SDP810 read error (skipping frame): {e}")
            except OSError as e:
                print(f"SDP810 I2C error: {_decode_i2c_error(e)}")
                await asyncio.sleep(1.0) 
        await asyncio.sleep(0.05)

async def main():
    await sdp810_start()

    await asyncio.gather(
        run_server(),
        handle_websockets(),
        measure_airspeed(),
        sensor_broadcaster(),
        dimmer_updater(),
        adc_sampler(),
    )

asyncio.run(main())