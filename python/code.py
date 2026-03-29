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

# ---------------------------------------------------------------------------
# Pin setup
# ---------------------------------------------------------------------------
DPS_PIN = analogio.AnalogIn(board.A1)   # Differential Pressure Sensor

# RobotDyn AC dimmer module
#   ZC  → zero-cross detection output of the module  → GP2  (input)
#   PWM → gate trigger input  of the module           → GP3  (output)
# Change D5/D6 to whatever pins you have wired.
ZC_PIN = digitalio.DigitalInOut(board.GP2)
ZC_PIN.direction = digitalio.Direction.INPUT
ZC_PIN.pull = digitalio.Pull.DOWN       # keeps the line defined-low between pulses

GATE_PIN = digitalio.DigitalInOut(board.GP3)
GATE_PIN.direction = digitalio.Direction.OUTPUT
GATE_PIN.value = False                  # gate off at start-up

# ---------------------------------------------------------------------------
# AC dimmer configuration
# ---------------------------------------------------------------------------
AC_FREQUENCY     = 50          # Hz  — change to 60 for 60 Hz mains
AC_HALF_PERIOD   = 1.0 / (AC_FREQUENCY * 2)   # 10 ms @ 50 Hz
# Firing-angle window inside one half-cycle.
# Fire early (small delay)  → more power / faster fan.
# Fire late  (large delay)  → less power / slower fan.
MIN_FIRING_DELAY = 0.001       # 1.0 ms  — near-full power
MAX_FIRING_DELAY = 0.0090      # 9.0 ms  — near-minimum usable power
GATE_PULSE_S     = 0.000010    # 10 µs   — enough to latch the triac

# ---------------------------------------------------------------------------
# Fan state
# ---------------------------------------------------------------------------
fan_running       = False
current_fan_speed = 0          # 0–100 %

# ---------------------------------------------------------------------------
# DPS / airspeed globals
# ---------------------------------------------------------------------------
division_ratio           = 2.739 / 1.835
air_density              = 1.225        # kg/m³
sensor_baseline          = 2.5
num_calibration_samples  = 50
smoothed_airspeed_ms     = 0
voltage_history          = []

# PID parameters (reserved for future fan control)
Kp = 0
Ki = 0
Kd = 0

# ---------------------------------------------------------------------------
# WiFi / server configuration
# ---------------------------------------------------------------------------
SSID     = "Zephyros"
PASSWORD = "password"
PORT     = 80

# ---------------------------------------------------------------------------
# Hardware – LED
# ---------------------------------------------------------------------------
led           = digitalio.DigitalInOut(board.LED)
led.direction = digitalio.Direction.OUTPUT

# ---------------------------------------------------------------------------
# Access point
# ---------------------------------------------------------------------------
print("Creating access point...")
wifi.radio.start_ap(ssid=SSID, password=PASSWORD)
print("Access point started")
print("AP IP Address:", wifi.radio.ipv4_address_ap)

pool   = socketpool.SocketPool(wifi.radio)
server = Server(pool, "/static", debug=True)

# ---------------------------------------------------------------------------
# WebSocket state
# ---------------------------------------------------------------------------
current_websocket    = None
last_message_time    = 0
MIN_MESSAGE_INTERVAL = 0.05   # seconds

# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------
@server.route("/")
def index(request: Request):
    return Response(request, open("/static/index.html").read(), content_type="text/html")

@server.route("/static/<path>")
def static_files(request: Request, path: str):
    return Response.from_file(request, f"/static/{path}")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def blink(count, on_time=0.1, off_time=0.1):
    for _ in range(count):
        led.value = True
        await asyncio.sleep(on_time)
        led.value = False
        await asyncio.sleep(off_time)

@server.route("/ws", GET)
def ws_handler(request: Request):
    global current_websocket
    websocket        = Websocket(request)
    current_websocket = websocket
    print("WebSocket client connected")
    asyncio.create_task(blink(2))
    return websocket

# ---------------------------------------------------------------------------
# WebSocket message handler
# ---------------------------------------------------------------------------
async def handle_websocket_message(message):
    global sensor_baseline, Kp, Ki, Kd, division_ratio, air_density
    global fan_running, current_fan_speed

    try:
        data = json.loads(message)
        print(data)

        # ---- existing actions ------------------------------------------------
        if data.get('action') == 'calibrate':
            await calibrate_dps()

        elif data.get('action') == 'send_settings':
            await send_current_settings()

        elif data.get('action') == 'new_settings':
            sensor_baseline = data.get('sensor_baseline', sensor_baseline)
            Kp              = data.get('Kp',              Kp)
            Ki              = data.get('Ki',              Ki)
            Kd              = data.get('Kd',              Kd)
            division_ratio  = data.get('division_ratio',  division_ratio)
            air_density     = data.get('air_density',     air_density)
            await asyncio.sleep(0.1)
            await send_current_settings()

        # ---- fan / triac actions ---------------------------------------------
        elif data.get('action') == 'stop_fan':
            fan_running       = False
            current_fan_speed = 0
            GATE_PIN.value    = False   # make sure gate is off immediately
            print("Fan stopped")

        elif data.get('action') == 'start_fan':
            fan_running = True
            if current_fan_speed == 0:
                current_fan_speed = 50  # sensible default if no speed was set yet
            print(f"Fan started at {current_fan_speed}%")

        elif data.get('action') == 'set_fan_speed':
            raw_speed         = data.get('speed', 0)
            current_fan_speed = max(0, min(100, int(raw_speed)))
            # Treat speed 0 as an implicit stop
            fan_running = current_fan_speed > 0
            if not fan_running:
                GATE_PIN.value = False
            print(f"Fan speed set to {current_fan_speed}%")

    except Exception as e:
        print("Error handling WebSocket message:", e)

# ---------------------------------------------------------------------------
# WebSocket send helper
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# WebSocket receive loop
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# HTTP server poll loop
# ---------------------------------------------------------------------------
async def run_server():
    server.start(str(wifi.radio.ipv4_address_ap), PORT)
    print(f"Server running on http://{wifi.radio.ipv4_address_ap}:{PORT}")
    while True:
        try:
            server.poll()
        except Exception as e:
            print("Server poll error:", e)
        await asyncio.sleep(0)

# ---------------------------------------------------------------------------
# Triac / AC dimmer controller
# ---------------------------------------------------------------------------
async def triac_controller():
    """
    Watches the zero-cross pin from the RobotDyn module and fires the gate
    at the calculated phase angle for the requested fan speed.

    Speed → firing delay mapping (linear approximation):
        100 % → MIN_FIRING_DELAY  (fire early  → full power)
          0 % → gate never fired  (triac off)
          1 % → MAX_FIRING_DELAY  (fire late   → minimum power)

    Note: asyncio.sleep() has ~1 ms jitter on CircuitPython, which is
    acceptable for fan speed control but will give slightly uneven dimming
    at very low speeds. The 10 µs gate pulse itself uses time.sleep()
    (blocking) to guarantee the triac latches reliably.
    """
    prev_zc = False

    while True:
        if not fan_running or current_fan_speed == 0:
            GATE_PIN.value = False
            await asyncio.sleep(0.005)   # idle: recheck every 5 ms
            continue

        zc = ZC_PIN.value

        if zc and not prev_zc:
            # Rising edge detected: zero-cross occurred.
            # Map speed (1–100 %) to a firing delay (MAX → MIN).
            ratio = current_fan_speed / 100.0
            firing_delay = MAX_FIRING_DELAY - ratio * (MAX_FIRING_DELAY - MIN_FIRING_DELAY)

            await asyncio.sleep(firing_delay)   # wait for the right phase angle

            # Pulse the gate. Use blocking time.sleep for the tiny pulse so
            # asyncio overhead cannot stretch it and miss the triac latch.
            GATE_PIN.value = True
            time.sleep(GATE_PULSE_S)            # 10 µs — blocking but harmless
            GATE_PIN.value = False

        prev_zc = zc
        await asyncio.sleep(0)   # yield to other tasks between samples

# ---------------------------------------------------------------------------
# Telemetry broadcaster
# ---------------------------------------------------------------------------
async def sensor_broadcaster():
    while True:
        if current_websocket:
            telemetry = {
                "type":       "telemetry",
                "voltage":    0.3,
                "resistance": 10000,
                "power":      10,
                "air_speed":  smoothed_airspeed_ms,
                "fan_speed":  current_fan_speed,   # ← real value now
                "fan_on":     fan_running,
                "uptime":     time.monotonic(),
            }
            await send_websocket_message(telemetry)
        await asyncio.sleep(0.5)

# ---------------------------------------------------------------------------
# Settings broadcast
# ---------------------------------------------------------------------------
async def send_current_settings():
    if current_websocket:
        settings = {
            "type":           "settings",
            "sensor_baseline": sensor_baseline,
            "Kp":             Kp,
            "Ki":             Ki,
            "Kd":             Kd,
            "division_ratio": division_ratio,
            "air_density":    air_density,
        }
        await send_websocket_message(settings)

# ---------------------------------------------------------------------------
# DPS / airspeed helpers
# ---------------------------------------------------------------------------
async def measure_dps(pin):
    return float(((pin.value * pin.reference_voltage) / 65535) * division_ratio)

async def measure_airspeed(window_size=8):
    global smoothed_airspeed_ms, voltage_history, sensor_baseline
    while True:
        if current_websocket:
            raw_voltage = await measure_dps(DPS_PIN)
            voltage_history.append(raw_voltage)
            if len(voltage_history) > window_size:
                voltage_history.pop(0)
            smoothed_voltage = sum(voltage_history) / len(voltage_history)

            voltage_diff = smoothed_voltage - sensor_baseline
            pressure_pa  = voltage_diff * 1000
            if pressure_pa < 0:
                smoothed_airspeed_ms = math.sqrt((-2 * pressure_pa) / air_density)
            else:
                smoothed_airspeed_ms = math.sqrt((2 * pressure_pa) / air_density)

            #print(f"Voltage smooth: {smoothed_voltage:.5f}V | "
            #      f"Voltage raw: {raw_voltage:.5f}V | "
            #      f"Airspeed: {smoothed_airspeed_ms:.2f} m/s")
        await asyncio.sleep(0.05)

async def calibrate_dps():
    global sensor_baseline
    print("Calibrating Sensor")
    calibration_baseline = 0
    for _ in range(num_calibration_samples):
        calibration_baseline += await measure_dps(DPS_PIN)
        await asyncio.sleep(0)
    sensor_baseline = calibration_baseline / num_calibration_samples
    print(f"New sensor baseline: {sensor_baseline}")
    return sensor_baseline

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
async def main():
    await asyncio.gather(
        calibrate_dps(),
        run_server(),
        handle_websockets(),
        measure_airspeed(),
        sensor_broadcaster(),
        triac_controller(),
    )

asyncio.run(main())