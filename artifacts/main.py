import os
import base64
import threading
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from deepgram import DeepgramClient, PrerecordedOptions
from dotenv import load_dotenv
import io
import numpy as np

load_dotenv()

# FastAPI app setup
app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

# Parameters for microphone recording
SAMPLE_RATE = 16000
CHANNELS = 1

class DeepgramHandler:
    def __init__(self, websocket):
        self.websocket = websocket
        self.deepgram = DeepgramClient(api_key=os.getenv("DEEPGRAM_API_KEY"))
        self.dg_connection = None

    async def setup_connection(self):
        try:
            # Setup Deepgram connection with transcription options
            self.dg_connection = self.deepgram.listen.rest.v("1")
            options = PrerecordedOptions(
                model="nova-2",
                smart_format=True,
            )
            await self.dg_connection.start(options)
        except Exception as e:
            print(f"Error setting up Deepgram connection: {str(e)}")
            raise

    async def process_audio(self, audio_data):
        try:
            # Decode base64 audio data
            audio_bytes = base64.b64decode(audio_data)
            
            # Send the audio data to Deepgram for transcription
            payload = {
                "buffer": audio_bytes
            }
            response = await self.dg_connection.transcribe_file(payload)
            transcript = response.get("results", {}).get("channels", [{}])[0].get("alternatives", [{}])[0].get("transcript", "")
            
            # Send the transcript back to the client
            await self.websocket.send_json({
                'type': 'transcript',
                'text': transcript
            })
        except Exception as e:
            print(f"Error processing audio: {str(e)}")
            await self.websocket.send_json({
                'type': 'error',
                'message': f"Error processing audio: {str(e)}"
            })

    async def cleanup(self):
        try:
            # Perform cleanup actions if needed
            if self.dg_connection:
                await self.dg_connection.finish()
        except Exception as e:
            print(f"Error during cleanup: {str(e)}")

async def process_frame(frame_data):
    # Convert base64 to image
    img_data = base64.b64decode(frame_data.split(',')[1])
    nparr = np.frombuffer(img_data, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    return img
    
async def get_llm_response(prompt):
    try:
        # Open a streaming connection to the Ollama API
        response = requests.post(
            'http://localhost:11434/api/generate',
            json={"model": "llama3.2:1b", "prompt": prompt},
            stream=True,
            timeout=10
        )

        # Ensure the response is valid
        if response.status_code != 200:
            return f"Error: Received status code {response.status_code} from Ollama."

        full_response = ""
        for line in response.iter_lines(decode_unicode=True):
            if line.strip():  # Ensure the line is not empty
                try:
                    json_data = json.loads(line)
                    full_response += json_data.get("response", "")
                    if json_data.get("done", False):  # Stop when `done` is true
                        break
                except json.JSONDecodeError as e:
                    print(f"Error decoding JSON: {e}, Line: {line}")
                    return f"Error: Received invalid JSON from Ollama."

        return full_response.strip() or "No response from the model."

    except requests.exceptions.RequestException as e:
        print(f"Error connecting to Ollama: {e}")
        return "Error: Could not connect to Ollama. Please make sure it's running."

@app.get("/")
async def get():
    with open('static/index.html', 'r') as f:
        return HTMLResponse(content=f.read())


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    try:
        while True:
            data = await websocket.receive_json()
            
            if data['type'] == 'screen':
                # Process screen capture
                screen_img = await process_frame(data['data'])
                # Add screen processing logic here
                
            elif data['type'] == 'webcam':
                # Process webcam frame
                webcam_img = await process_frame(data['data'])
                # Add webcam processing logic here
                
            elif data['type'] == 'audio':
                try:
                    # Process audio with Deepgram
                    audio_data = base64.b64decode(data['data'])
                    
                    # Configure transcription options
                    options = PrerecordedOptions(smart_format=True)
                    
                    # Get transcription using the correct v3 API method
                    response = await deepgram.transcription.prerecorded({
                        "buffer": audio_data,
                        "mimetype": 'audio/webm'
                    }, options)
                    
                    # Extract transcript from response
                    transcript = response["results"]["channels"][0]["alternatives"][0]["transcript"]
                    
                    # Send transcript to client
                    if transcript.strip():
                        await websocket.send_json({
                            'type': 'transcript',
                            'text': transcript
                        })
                    
                        # Get LLM response
                        llm_response = await get_llm_response(transcript)
                        
                        # Convert response to speech
                        engine.say(llm_response)
                        engine.runAndWait()
                        
                        # Send response back to client
                        await websocket.send_json({
                            'type': 'response',
                            'text': llm_response
                        })
                
                except Exception as e:
                    print(f"Error processing audio: {str(e)}")
                    await websocket.send_json({
                        'type': 'error',
                        'message': f"Error processing audio: {str(e)}"
                    })

    except Exception as e:
        print(f"Error: {str(e)}")
        try:
            await websocket.send_json({
                'type': 'error',
                'message': f"WebSocket error: {str(e)}"
            })
        except:
            pass
        finally:
            await websocket.close()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="prime-lab.cs.vt.edu", port=8000)

