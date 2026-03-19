import time
import json
import wifi
import socketpool
import mdns
from adafruit_httpserver import Server, Request, Response, Websocket, GET
import asyncio
import board
import digitalio
import analogio
import math


# Pin setup:
DPS_PIN = analogio.AnalogIn(board.A1) # Pin for the Differential Pressure Sensor # Normal voltage = 2.614V
DIVISION_RATIO = 1.5 # Because of the 10K / 20K resistor divider
AIR_DENSITY = 1.225 # kg/m^3

sensor_baseline = 2.5 # 
num_calibration_samples = 50
smoothed_airspeed_ms = 0
voltage_history = []


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
    try:
        data = json.loads(message)
        print(data)
        if 'brightness' in data:
            led.value = float(data['brightness']) > 0
        elif data.get('action') == 'calibrate':
            await calibrate_dps()
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
        json_data = json.dumps(data)
        current_websocket.send_message(json_data)
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


# here comes the code that sends sensor data
# To do, change dummy data to real readings.
async def sensor_broadcaster():
    while True:
        if current_websocket:
            # Gather all sensor data into one 'telemetry' packet
            telemetry = {
                "type": "telemetry",
                "power": 21,
                "fan_speed": 80, #current_fan_speed,
                "uptime": time.monotonic(),
                "air_speed": smoothed_airspeed_ms,
            }
            await send_websocket_message(telemetry)

        await asyncio.sleep(0.5)  # 2Hz is plenty for a UI


# Outputs real DPS voltage (scaled from 3.3 to 5V)
async def measure_dps(pin):
    return float(( (pin.value * pin.reference_voltage) / 65535 ) * DIVISION_RATIO)


async def measure_airspeed(window_size=8):
    global smoothed_airspeed_ms, voltage_history


    while True:
        if current_websocket:
            raw_voltage = await measure_dps(DPS_PIN)

            # Smooth the ADC voltage readings
            voltage_history.append(raw_voltage)
            if len(voltage_history) > window_size:
                voltage_history.pop(0)
            smoothed_voltage = sum(voltage_history) / len(voltage_history)

            # Convert smoothed voltage to airspeed
            voltage_diff = smoothed_voltage - sensor_baseline
            pressure_pa = (voltage_diff / 10) * 1000
            
            pressure_pa = max(0, pressure_pa)


            smoothed_airspeed_ms = math.sqrt((2 * pressure_pa) / AIR_DENSITY)

            print(f"Voltage smooth: {smoothed_voltage:.5f}V | Voltage raw: {raw_voltage:.5f}V | Airspeed: {smoothed_airspeed_ms:.2f} m/s")

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



# Run the main loop
async def main():
    await asyncio.gather(
        calibrate_dps(),
        run_server(),
        handle_websockets(),
        measure_airspeed(),
        sensor_broadcaster(),
    )

asyncio.run(main())