import time
import json
import machine
import network
from microdot import Microdot, Response, send_file
from microdot.websocket import with_websocket
import asyncio
from machine import Pin, PWM

# WiFi configuration
SSID = "Zephyros"
PASSWORD = "password"
PORT = 80

led = Pin("LED", Pin.OUT)


# Setup WiFi AP
ap = network.WLAN(network.AP_IF)
ap.active(True)
ap.config(essid=SSID, password=PASSWORD)
# It's also good practice to wait a moment for the AP and DHCP server to stabilize
while not ap.active():
    time.sleep(0.1)
print("Access point started")
print("Network config:", ap.ifconfig())

# WebSocket state
websocket = None
last_message_time = time.ticks_ms()
MIN_MESSAGE_INTERVAL = 50  # ms

# Create Microdot app
app = Microdot()
Response.default_content_type = 'text/html'

# Serve static files
@app.route('/')
def index(request):
    return send_file('static/index.html')

@app.route('/static/<path:path>')
def static(request, path):
    return send_file('static/' + path)

@app.errorhandler(Exception)
def handle_exception(request, exception):
    print(f"Server error: {type(exception).__name__}: {exception}")
    return {"error": str(exception)}, 500

# WebSocket route
@app.route('/ws')
@with_websocket
async def ws(request, ws):
    global websocket

    if websocket is not None:
        try:
            await ws.close()
        except:
            pass

    websocket = ws
    print("WebSocket client connected")

    try:
        while True:
            data = await ws.receive()
            if data:
                await handle_websocket_message(data)
    except Exception as e:
        print(f"WebSocket error: {type(e).__name__}: {e}")
    finally:
        if websocket == ws:
            websocket = None
            print("WebSocket client disconnected")

async def send_websocket_message(data, important=False):
    global websocket, last_message_time

    if websocket is None:
        return False

    current_time = time.ticks_ms()

    if not important and (time.ticks_diff(current_time, last_message_time) < MIN_MESSAGE_INTERVAL):
        return False

    try:
        json_data = json.dumps(data)
        await websocket.send(json_data)
        last_message_time = current_time
        return True
    except Exception as e:
        print("Error sending message:", e)
        return False

async def handle_websocket_message(message):
    print(message)
    try:
        # Assuming the message is a raw number string like "50" (0-100 range)
        # Or you can parse JSON if your frontend sends: {"brightness": 50}
        data = json.loads(message)
        
        if 'brightness' in data:
                # If brightness > 0, turn it on; else off
                led.value(1 if float(data['brightness']) > 0 else 0)
            
    except Exception as e:
        print("Error handling WebSocket message:", e)

async def start_server():
    try:
        await app.start_server(host='0.0.0.0', port=PORT, debug=True)
    except Exception as e:
        print("Server error:", e)
        machine.reset()

async def run_main_loop():
    while True:
        # Your main logic here
        await asyncio.sleep(0.001)

def main():
    loop = asyncio.get_event_loop()
    loop.create_task(run_main_loop())
    loop.create_task(start_server())
    loop.run_forever()

if __name__ == "__main__":
    main()