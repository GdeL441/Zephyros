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

# Command codes (write to _REG_COMMAND)
_CMD_SOFT_RESET   = 0x01
_CMD_RECALIBRATE  = 0x02

# Curve register values
_CURVE_LINEAR = 0
_CURVE_RMS    = 1
_CURVE_LOG    = 2
_CURVE_CODE_TO_NAME = {0: "linear", 1: "rms", 2: "log"}
_CURVE_NAME_TO_CODE = {"linear": 0, "rms": 1, "log": 2}

_DIMMER_READ_INTERVAL_S       = 0.1
_DIMMER_CURVE_POLL_INTERVAL_S = 2.0   # Curve register re-sync cadence
_DIMMER_MAX_FAILURES          = 3
_I2C_LOCK_TIMEOUT             = 50

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
fan_control_mode            = "percent"  # "percent" (default) or "pid"

# Last known dimmer curve mode ("linear" | "rms" | "log" | "unknown").
# Updated on successful writes and on periodic readback.
dimmer_curve_mode           = "unknown"
_last_curve_poll_s          = 0.0

# ── PID controller state ──────────────────────────────────────────────────────
# Matches block diagram: e = r - y through Kp, Ki (with anti-windup Kt),
# and -y through low-pass filter (1/(1+sTf)) then Kd*s for derivative.
_DIMMER_MIN_PERCENT   = 40    # Minimum dimmer output (TRIAC can't fire below this)
_PID_WINDUP_DURATION  = 5.0   # Seconds to ramp from 0 → 75% on PID start
_PID_WINDUP_LEVEL     = 75    # Target level during wind-up phase
_PID_OUTPUT_MIN       = 40    # Clamp: actuator lower bound (%)
_PID_OUTPUT_MAX       = 100   # Clamp: actuator upper bound (%)
_PID_DT               = 0.05  # Controller sample period (20 Hz)


# Runtime PID variables (reset on mode switch)
_pid_target_airspeed  = 0.0   # Setpoint r (m/s)
_pid_integral         = 0.0   # Integrator state
_pid_prev_y_filt      = 0.0   # Previous filtered measurement (for derivative)
_pid_windup_start     = 0.0   # monotonic time when PID mode was entered
_pid_active           = False # True once wind-up is complete and loop is running
_pid_output           = 0.0   # Last computed controller output (for telemetry)
_pid_prev_d_filt      = 0.0   # Last filtered derivative of -y

def set_target_fan_speed(percent: float) -> None:
    global target_fan_speed, current_fan_speed
    percent = max(0.0, float(percent))
    target_fan_speed      = percent
    current_fan_speed     = percent
    _speed_event.set()

def set_pid_setpoint(airspeed_ms: float) -> None:
    """Set the PID target airspeed (m/s). Only effective when fan_control_mode == 'pid'."""
    global _pid_target_airspeed, _pid_active, _pid_windup_start
    global _pid_integral, _pid_prev_y_filt, _pid_prev_d_filt, _pid_output
    new_setpoint = max(0.0, float(airspeed_ms))
    # Coming out of a zero setpoint while in PID mode → re-arm wind-up so the
    # loop ramps in smoothly instead of starting cold against the output clamp.
    if fan_control_mode == "pid" and _pid_target_airspeed <= 0 and new_setpoint > 0:
        _pid_active       = False
        _pid_integral     = 0.0
        _pid_prev_y_filt  = 0.0
        _pid_prev_d_filt  = 0.0
        _pid_output       = 0.0
        _pid_windup_start = time.monotonic()
        print("PID: setpoint 0 → non-zero, restarting wind-up")
    _pid_target_airspeed = new_setpoint
    print(f"PID: setpoint = {_pid_target_airspeed:.2f} m/s")

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

# ── PID controller background task ───────────────────────────────────────────

def _pid_reset() -> None:
    """Zero all PID integrator / filter state for a clean start."""
    global _pid_integral, _pid_prev_y_filt, _pid_active, _pid_output, _pid_prev_d_filt
    global _pid_windup_start, _pid_target_airspeed
    _pid_integral       = 0.0
    _pid_prev_y_filt    = 0.0
    _pid_active         = False
    _pid_output         = 0.0
    _pid_windup_start   = time.monotonic()
    _pid_prev_d_filt    = 0.0
    _pid_target_airspeed = 5.0  # Default to 5 m/s on PID entry
    print("PID: state reset (setpoint = 5.0 m/s)")

def _switch_to_pid() -> None:
    """Safely enter PID mode: reset state and begin wind-up."""
    global fan_control_mode
    _pid_reset()
    fan_control_mode = "pid"
    print("PID: entering PID mode — wind-up phase starting")

def _switch_to_percent() -> None:
    """Safely leave PID mode: stop PID, set dimmer to 0%, return to percent."""
    global fan_control_mode, _pid_active
    _pid_active = False
    fan_control_mode = "percent"
    set_target_fan_speed(0)
    print("PID: switched to percent mode — fan set to 0%")

async def pid_controller() -> None:
    """PID control loop running at 1/_PID_DT Hz.

    Block diagram implementation:
      e = r - y                        (error)
      v = Kp*e + integral + Kd*d_filt  (unsaturated output)
      u = clamp(v, min, max)            (actuator output)
      es = u - v                        (saturation error)
      integral += (Ki*e + Kt*es) * dt   (anti-windup back-calculation)
      d_filt: -y through 1st-order LPF, then finite-difference derivative
    """
    global _pid_integral, _pid_prev_y_filt, _pid_active, _pid_output, _pid_prev_d_filt
    
    await asyncio.sleep(1.0)  # Let other tasks settle
    last_time = time.monotonic()
    while True:
        await asyncio.sleep(_PID_DT)
        now = time.monotonic()
        actual_dt = now - last_time
        last_time = now

        if fan_control_mode != "pid":
            continue

        # ── Wind-up phase: hold at 75% for 5 s before engaging the loop ──
        elapsed = time.monotonic() - _pid_windup_start
        if not _pid_active:
            if elapsed < _PID_WINDUP_DURATION:
                # Hold at _PID_WINDUP_LEVEL for the full duration
                set_target_fan_speed(_PID_WINDUP_LEVEL)
                _pid_output = _PID_WINDUP_LEVEL
                continue
            else:
                # Wind-up complete — seed the integrator so the loop starts
                # smoothly from the current operating point.
                _pid_active = True
                _pid_integral = _PID_WINDUP_LEVEL  # pre-load integrator
                _pid_prev_y_filt = smoothed_airspeed_ms
                print(f"PID: wind-up complete, loop active (seeded at {_PID_WINDUP_LEVEL}%)")

        # ── Measurement ───────────────────────────────────────────────
        r  = _pid_target_airspeed      # setpoint (m/s)
        y  = smoothed_airspeed_ms      # measured airspeed (m/s)
        dt = actual_dt
        if dt <= 0.001: 
            continue # Prevent division by zero

        # ── Setpoint 0 m/s → turn fan off (bypass minimum) ────────────
        if r <= 0:
            _pid_output = 0.0
            _pid_integral = 0.0
            set_target_fan_speed(0)
            continue

        # ── Error ─────────────────────────────────────────────────────
        e = r - y

        # ── Derivative on measurement (-y) with low-pass filter ──────
        # Calculate raw derivative of -y
        raw_d = -(y - _pid_prev_y_filt) / dt
        
        # Apply low-pass filter to the derivative
        alpha = dt / (Tf + dt) if Tf > 0 else 1.0
        d_filt = alpha * raw_d + (1.0 - alpha) * _pid_prev_d_filt
        
        # Save states for next loop
        _pid_prev_y_filt = y
        _pid_prev_d_filt = d_filt
        
        # ── PID terms ─────────────────────────────────────────────────
        P = Kp * e
        D = Kd * d_filt
        v = P + _pid_integral + D       # unsaturated output

        # ── Actuator saturation (clamp) ──────────────────────────────
        u = max(_PID_OUTPUT_MIN, min(_PID_OUTPUT_MAX, v))

        # ── Anti-windup: back-calculation ─────────────────────────────
        es = u - v  # saturation error
        _pid_integral += (Ki * e + Kt * es) * dt

        # ── Apply output ──────────────────────────────────────────────
        _pid_output = u
        set_target_fan_speed(int(u))


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

async def _dimmer_set_curve(mode: str) -> bool:
    """Write the curve register (0x11). mode ∈ {linear, rms, log}."""
    global dimmer_curve_mode
    code = _CURVE_NAME_TO_CODE.get(mode)
    if code is None:
        print(f"DimmerLink: unknown curve mode {mode!r}")
        return False
    ok = await _dimmer_write_reg(_REG_CURVE, code)
    if ok:
        dimmer_curve_mode = mode
        print(f"DimmerLink: curve set to {mode}")
    return ok

async def _dimmer_read_curve_cached() -> str:
    """Return the cached dimmer curve mode, refreshing from the chip every
    _DIMMER_CURVE_POLL_INTERVAL_S seconds. Read failures keep the last value."""
    global dimmer_curve_mode, _last_curve_poll_s
    now = time.monotonic()
    if (now - _last_curve_poll_s) < _DIMMER_CURVE_POLL_INTERVAL_S:
        return dimmer_curve_mode
    _last_curve_poll_s = now
    val = await _dimmer_read_reg(_REG_CURVE)
    if val is not None:
        dimmer_curve_mode = _CURVE_CODE_TO_NAME.get(val, "unknown")
    return dimmer_curve_mode

async def recalibrate_dimmerlink() -> bool:
    """Ask DimmerLink to re-measure the mains AC frequency (cmd 0x02)."""
    print("DimmerLink: triggering recalibration")
    return await _dimmer_write_reg(_REG_COMMAND, _CMD_RECALIBRATE)

async def reset_dimmerlink() -> bool:
    """Soft-reset the DimmerLink controller (cmd 0x01)."""
    print("DimmerLink: triggering soft reset")
    return await _dimmer_write_reg(_REG_COMMAND, _CMD_SOFT_RESET)


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
_AIRSPEED_ALPHA      = 0.30   # EMA smoothing for airspeed (lower = smoother)
current_temperate = 15
current_pressure = 101325
air_density = current_pressure / (R_SPECIFIC * (current_temperate + 273.15))

Kp = 15.0   # Proportional gain
Ki = 4.0    # Integral gain
Kd = 0.5    # Derivative gain
Kt = 1.2    # Anti-windup tracking gain
Tf = 0.1    # Derivative filter time constant (seconds)

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
    global Kp, Ki, Kd, Kt, Tf, shunt_value, current_fan_speed, fan_control_mode
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
            if fan_control_mode == "pid":
                # In PID mode, the slider sets airspeed setpoint (m/s)
                set_pid_setpoint(speed)
            else:
                current_fan_speed = speed
                set_target_fan_speed(speed)
        elif data.get('action') == "send_data":
            await send_plotting_data()
        elif data.get('action') == 'percent_mode':
            _switch_to_percent()
        elif data.get('action') == 'pid_mode':
            _switch_to_pid()
        elif data.get('action') == 'emergency_stop':
            _switch_to_percent()  # kills PID, sets fan to 0%
            print("EMERGENCY STOP — fan immediately set to 0%")
        elif data.get('action') == 'new_settings':
            Kp = data.get('Kp', Kp)
            Ki = data.get('Ki', Ki)
            Kd = data.get('Kd', Kd)
            Kt = data.get('Kt', Kt)
            Tf = data.get('Tf', Tf)
            shunt_value = data.get('shunt_value', shunt_value)
            await asyncio.sleep(0.1)
            await send_current_settings()
        elif data.get('action') == 'reset_dimmerlink':
            await reset_dimmerlink()
        elif data.get('action') in ('recalibrate_dimmerlink', 'calibrate_dimmerlink'):
            await recalibrate_dimmerlink()
        elif data.get('action') == 'set_dimmer_curve':
            mode = data.get('mode')
            await _dimmer_set_curve(mode)
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

def _ws_receive(ws):
    """Non-blocking WebSocket receive that tolerates older lib versions
    where receive() raises RuntimeError on no data instead of returning None."""
    try:
        return ws.receive(fail_silently=True)
    except TypeError:
        try:
            return ws.receive()
        except (RuntimeError, OSError):
            return None

async def handle_websockets():
    global current_websocket
    while True:
        if current_websocket is not None:
            ws = current_websocket
            try:
                # Drain pending frames each pass so rapid clicks aren't lost
                for _ in range(8):
                    data = _ws_receive(ws)
                    if not data:
                        break
                    await handle_websocket_message(data)
            except (ConnectionError, OSError) as e:
                print(f"WebSocket dropped: {e}")
                if current_websocket is ws:
                    current_websocket = None
                _on_websocket_disconnect()
                asyncio.create_task(blink(3, on_time=0.05, off_time=0.05))
        await asyncio.sleep(0.01)

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
                "type":              "telemetry",
                "voltage":           round(voltage, 4),
                "resistance":        shunt_value,
                "power":             round(power_mw, 4),
                "air_speed":         smoothed_airspeed_ms,
                "fan_speed":         await get_dimmer_percent(),
                "uptime":            time.monotonic(),
                "fan_mode":          fan_control_mode,
                "temperature":       round(current_temperate, 2),
                "air_density":       round(air_density, 4),
                "dimmer_curve_mode": await _dimmer_read_curve_cached(),
            }
            # Add PID-specific telemetry when in PID mode
            if fan_control_mode == "pid":
                telemetry["pid_setpoint"]  = round(_pid_target_airspeed, 2)
                telemetry["pid_output"]    = round(_pid_output, 1)
                telemetry["pid_active"]    = _pid_active
            await send_websocket_message(telemetry)
        await asyncio.sleep(0.1)

async def send_current_settings():
    if current_websocket:
        settings = {
            "type":           "settings",
            "Kp":             Kp,
            "Ki":             Ki,
            "Kd":             Kd,
            "Kt":             Kt,
            "Tf":             Tf,
            "shunt_value":    shunt_value,
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
                    raw_airspeed = -1 * math.sqrt((2.0 * abs(pressure_pa)) / air_density)
                else:
                    raw_airspeed = math.sqrt((2.0 * pressure_pa) / air_density)
                # EMA smoothing for stable display and PID feedback
                smoothed_airspeed_ms = (_AIRSPEED_ALPHA * raw_airspeed
                                        + (1 - _AIRSPEED_ALPHA) * smoothed_airspeed_ms)
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
        pid_controller(),
    )

asyncio.run(main())