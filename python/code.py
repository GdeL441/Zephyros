import time
import json
import wifi
import socketpool
from adafruit_httpserver import Server, Request, Response, Websocket, GET
import asyncio
import board
import digitalio
import math
import busio
import struct

# ── UART / DimmerLink ─────────────────────────────────────────────────────────
_UART_TX_PIN = board.GP12
_UART_RX_PIN = board.GP13
_UART_BAUDRATE = 115200
_UART_TIMEOUT_S = 0.1
uart = busio.UART(tx=_UART_TX_PIN, rx=_UART_RX_PIN, baudrate=_UART_BAUDRATE, timeout=_UART_TIMEOUT_S)

target_fan_speed  = 0
current_fan_speed = 0
_last_sent_speed  = 0
_uart_busy        = False
_speed_event      = asyncio.Event()
_UART_ACK_OK      = 0x00
_UART_MIN_TX_GAP_S = 0.120
_DIMMER_POLL_INTERVAL_S = 2.0
_SPEED_SETTLE_WINDOW_S = 0.120
_last_uart_tx_s = 0.0
_last_percent_poll_s = 0.0
_last_known_dimmer_percent = 0
_last_target_update_s = 0.0
_consecutive_write_failures = 0


def set_target_fan_speed(percent: int) -> None:
    global target_fan_speed, current_fan_speed, _last_target_update_s
    percent = max(0, min(100, int(percent)))
    if percent == target_fan_speed:
        return
    target_fan_speed  = percent
    current_fan_speed = percent
    _last_target_update_s = time.monotonic()
    _speed_event.set()


async def _uart_recover():
    """Silence + drain — call after any failed transaction."""
    await asyncio.sleep(0.5)          # let dimmer finish whatever it was saying
    uart.reset_input_buffer()         # discard any mis-aligned response bytes


def _uart_reinit():
    """Recreate UART object if the bus/protocol stack wedges."""
    global uart
    try:
        uart.deinit()
    except Exception:
        pass
    time.sleep(0.050)
    uart = busio.UART(
        tx=_UART_TX_PIN,
        rx=_UART_RX_PIN,
        baudrate=_UART_BAUDRATE,
        timeout=_UART_TIMEOUT_S,
    )


async def _uart_wait_tx_slot():
    """Guarantee a minimum silence gap between UART commands."""
    global _last_uart_tx_s
    now = time.monotonic()
    wait_s = _UART_MIN_TX_GAP_S - (now - _last_uart_tx_s)
    if wait_s > 0:
        await asyncio.sleep(wait_s)
    _last_uart_tx_s = time.monotonic()


async def _read_dimmer_frame(wait_s: float = 0.050):
    """Read one full DimmerLink response frame after a command."""
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        if uart.in_waiting:
            await asyncio.sleep(0.005)
            frame = uart.read(uart.in_waiting)
            if frame:
                return frame
        await asyncio.sleep(0.002)
    return None


async def _dimmer_reset() -> bool:
    """
    Request a DimmerLink protocol reset (0x02 0x58).
    Best effort: some firmware revisions ACK it, others stay silent.
    """
    await _uart_wait_tx_slot()
    uart.reset_input_buffer()
    uart.write(bytes([0x02, 0x58]))
    frame = await _read_dimmer_frame(wait_s=0.080)
    status = frame[0] if frame else None

    if status is None:
        print("DimmerLink: reset sent (no ACK)")
        return True
    if status == _UART_ACK_OK:
        print("DimmerLink: reset ACK")
        return True

    print(f"DimmerLink: reset ERR 0x{status:02X}")
    return False


async def _dimmer_write(speed: int) -> bool:
    """One attempt: flush → send → wait → check ACK. Caller holds _uart_busy."""
    await _uart_wait_tx_slot()
    uart.reset_input_buffer()
    uart.write(bytes([0x02, 0x53, 0x00, speed]))
    frame = await _read_dimmer_frame(wait_s=0.140)
    status = frame[0] if frame else None

    if status == _UART_ACK_OK:
        return True
    if status is None:
        print("DimmerLink: no ACK")
        return False

    print(f"DimmerLink ERR: 0x{status:02X}")
    return False


async def dimmer_updater() -> None:
    global _last_sent_speed, _uart_busy, _last_known_dimmer_percent, _consecutive_write_failures

    await asyncio.sleep(0.3)
    uart.reset_input_buffer()

    while True:
        if target_fan_speed == _last_sent_speed:
            _speed_event.clear()
            await _speed_event.wait()

        # Coalesce slider bursts: wait for input to settle, then send only latest.
        while (time.monotonic() - _last_target_update_s) < _SPEED_SETTLE_WINDOW_S:
            await asyncio.sleep(0.01)
        speed = target_fan_speed

        while _uart_busy:
            await asyncio.sleep(0.01)
        _uart_busy = True
        try:
            sent = await _dimmer_write(speed)
        finally:
            _uart_busy = False

        if sent:
            _consecutive_write_failures = 0
            _last_sent_speed = speed
            _last_known_dimmer_percent = speed
            print(f"DimmerLink: {speed}% OK")
        else:
            # If command channel is wedged, issue protocol reset before retry.
            print(f"DimmerLink: retrying {speed}% after recovery/reset...")
            await _uart_recover()
            await _dimmer_reset()
            await asyncio.sleep(0.120)

            while _uart_busy:
                await asyncio.sleep(0.01)
            _uart_busy = True
            try:
                sent = await _dimmer_write(speed)
            finally:
                _uart_busy = False

            if sent:
                _consecutive_write_failures = 0
                _last_sent_speed = speed
                _last_known_dimmer_percent = speed
                print(f"DimmerLink: {speed}% OK (retry)")
            else:
                _consecutive_write_failures += 1
                print(f"DimmerLink: gave up on {speed}%")
                _last_sent_speed = speed   # stop looping on this value
                await _uart_recover()      # recover before accepting next command

                # Hard recovery if we fail repeatedly: reinitialize UART + reset protocol.
                if _consecutive_write_failures >= 2:
                    print("DimmerLink: hard recovery (UART reinit + reset)")
                    _uart_reinit()
                    await asyncio.sleep(0.150)
                    await _dimmer_reset()
                    await _uart_recover()


async def get_dimmer_percent():
    global _uart_busy, _last_percent_poll_s, _last_known_dimmer_percent
    now = time.monotonic()

    # Avoid extra UART traffic while a new speed is pending or after a recent poll.
    if target_fan_speed != _last_sent_speed:
        return _last_known_dimmer_percent
    if (now - _last_percent_poll_s) < _DIMMER_POLL_INTERVAL_S:
        return _last_known_dimmer_percent

    while _uart_busy:
        await asyncio.sleep(0.01)
    _uart_busy = True
    try:
        await _uart_wait_tx_slot()
        uart.reset_input_buffer()
        uart.write(bytes([0x02, 0x47, 0x00]))
        frame = await _read_dimmer_frame(wait_s=0.120)
        if frame and frame[0] == _UART_ACK_OK and len(frame) >= 2:
            _last_known_dimmer_percent = frame[1]
            _last_percent_poll_s = time.monotonic()
            return _last_known_dimmer_percent
    finally:
        _uart_busy = False
    return _last_known_dimmer_percent

# ── I2C & SDP810 setup ────────────────────────────────────────────────────────
try:
    i2c = busio.I2C(scl=board.GP27, sda=board.GP26, frequency=100_000)
except RuntimeError as e:
    print(f"I2C init failed: {e}")
    i2c = None

SDP810_ADDR       = 0x25
CMD_START_AVG     = bytes([0x36, 0x08])  # continuous measurement, averaged
CMD_STOP          = bytes([0x3F, 0xF9])
_sdp810_buf       = bytearray(9)         # pre-allocated, avoids GC pressure
_sdp810_running   = False

# ── CRC-8 (poly 0x31, init 0xFF) ─────────────────────────────────────────────
def _crc8(data: bytes) -> int:
    crc = 0xFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x31) if (crc & 0x80) else (crc << 1)
            crc &= 0xFF
    return crc

def _sdp810_write(cmd: bytes):
    if i2c is None:
        raise OSError("I2C not initialised")
    while not i2c.try_lock():
        pass
    try:
        i2c.writeto(SDP810_ADDR, cmd)
    finally:
        i2c.unlock()

# Replace your sdp810_start() call and the measure_airspeed loop:

_sdp810_available = False

def sdp810_start():
    global _sdp810_running, _sdp810_available
    try:
        _sdp810_write(CMD_START_AVG)
        _sdp810_running = True
        _sdp810_available = True
        time.sleep(0.020)
        print("SDP810 ready")
    except (RuntimeError, OSError) as e:
        print(f"SDP810 not found, running without sensor: {e}")
        _sdp810_available = False

def sdp810_stop():
    global _sdp810_running
    _sdp810_write(CMD_STOP)
    _sdp810_running = False

def sdp810_read() -> tuple:
    """
    Read one measurement frame (9 bytes) and return (pressure_pa, temperature_c).
    Raises ValueError on CRC mismatch.
    """
    while not i2c.try_lock():
        pass
    try:
        i2c.readfrom_into(SDP810_ADDR, _sdp810_buf)
    finally:
        i2c.unlock()

    # Verify all three CRCs
    if _crc8(_sdp810_buf[0:2]) != _sdp810_buf[2]:
        raise ValueError("SDP810 CRC fail: pressure bytes")
    if _crc8(_sdp810_buf[3:5]) != _sdp810_buf[5]:
        raise ValueError("SDP810 CRC fail: temperature bytes")
    if _crc8(_sdp810_buf[6:8]) != _sdp810_buf[8]:
        raise ValueError("SDP810 CRC fail: scale factor bytes")

    # struct.unpack ">h" = big-endian signed int16 — safe in all CircuitPython versions
    raw_pressure  = struct.unpack(">h", _sdp810_buf[0:2])[0]
    raw_temp      = struct.unpack(">h", _sdp810_buf[3:5])[0]
    scale_factor  = struct.unpack(">h", _sdp810_buf[6:8])[0]

    pressure_pa    = raw_pressure  / scale_factor   # Pa
    temperature_c  = raw_temp      / 200.0          # °C

    return pressure_pa, temperature_c

# ── Air data ──────────────────────────────────────────────────────────────────
division_ratio = 2.739 / 1.835
R_SPECIFIC = 287.05 # J/(kg·K)
smoothed_airspeed_ms = 0

current_temperate = 15 # °C
current_pressure = 101325 # Pa
air_density = current_pressure / (R_SPECIFIC * (current_temperate + 273.15))

# PID parameters (for fan control which will be implemented later)
Kp = 0
Ki = 0
Kd = 0


# WiFi configuration
SSID = "Zephyros"
PASSWORD = "password"
PORT = 80

# Setup LED
led = digitalio.DigitalInOut(board.LED)
led.direction = digitalio.Direction.OUTPUT

# Setup WiFi AP
print("Creating access point...")
wifi.radio.start_ap(ssid=SSID, password=PASSWORD)
print("Access point started")
print("AP IP Address:", wifi.radio.ipv4_address_ap)

# Create socket pool and server
pool = socketpool.SocketPool(wifi.radio)
server = Server(pool, "/static", debug=True)

# WebSocket state
current_websocket = None
last_message_time = 0
MIN_MESSAGE_INTERVAL = 0.05  # seconds

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
    print("WebSocket client connected")
    asyncio.create_task(blink(2))
    return websocket

async def handle_websocket_message(message):
    global Kp, Ki, Kd, division_ratio, air_density, current_fan_speed
    try:
        data = json.loads(message)
        print(data)

        if data.get('action') == 'calibrate':
            # SDP810 is self-zeroing — re-start continuous mode to trigger
            # the sensor's internal zero-point calibration sequence
            sdp810_stop()
            await asyncio.sleep(0.05)
            sdp810_start()
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
            division_ratio = data.get('division_ratio', division_ratio)
            air_density = data.get('air_density', air_density)
            await asyncio.sleep(0.1)
            await send_current_settings()

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
                print("WebSocket client disconnected")
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
            telemetry = {
                "type":       "telemetry",
                "voltage":    0.3,
                "resistance": 10000,
                "power":      10,
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
            "division_ratio": division_ratio,
            "air_density":    air_density,
        }
        await send_websocket_message(settings)

async def send_plotting_data():
    if current_websocket:
        data = { 
            "type": "plot_data",
            "airspeed": smoothed_airspeed_ms,
            "power": current_fan_speed,
        }
        await send_websocket_message(data)
            

async def measure_airspeed():
    """
    Continuously reads the SDP810 and updates smoothed_airspeed_ms.
    No software smoothing needed — CMD_START_AVG already averages all
    sensor samples accumulated between reads (~25 samples at 20 Hz polling).
    Temperature is also captured from each frame to keep air_density current.
    """
    global smoothed_airspeed_ms, air_density, current_temperate

    while True:
        if _sdp810_available:
            try:
                pressure_pa, temperature_c = sdp810_read()
                print(f"Pressure: {pressure_pa} Pa, Temperature: {temperature_c} °C")
                # Keep air density updated using live temperature from the sensor
                current_temperate = temperature_c
                air_density = current_pressure / (R_SPECIFIC * (temperature_c + 273.15))

                # Negative pressure = reversed flow or noise at zero — clamp to 0
                pressure_pa = max(0.0, pressure_pa)

                smoothed_airspeed_ms = math.sqrt((2.0 * pressure_pa) / air_density)

            except ValueError as e:
                # CRC mismatch — skip this frame, not a fatal error
                print(f"SDP810 read error (skipping frame): {e}")
            except OSError as e:
                # I2C bus error — sensor may have been disconnected
                print(f"SDP810 I2C error: {e}")
                await asyncio.sleep(1.0)  # back off before retrying

        await asyncio.sleep(0.05)  # 20 Hz

async def main():
    # Start the SDP810 before launching tasks
    print("Starting SDP810 continuous measurement...")
    sdp810_start()


    await asyncio.gather(
        run_server(),
        handle_websockets(),
        measure_airspeed(),
        sensor_broadcaster(),
        dimmer_updater(),
    )

asyncio.run(main())