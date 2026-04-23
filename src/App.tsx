/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { GoogleGenAI, Modality } from "@google/genai";
import { motion, AnimatePresence } from "motion/react";
import { 
  Mic, MicOff, Video, VideoOff, Send, MessageSquare, 
  Settings, Power, Info, Volume2, Sparkles, AlertCircle,
  Monitor, Zap, Key, X, ExternalLink
} from "lucide-react";
import { AudioStreamer, encodePCM16 } from "./lib/audio-utils";

// --- Types ---
interface ChatMessage {
  id: string;
  role: "user" | "model";
  text: string;
  timestamp: Date;
}

declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [isVideoOn, setIsVideoOn] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<string>("Ready to connect");
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [customApiKey, setCustomApiKey] = useState(() => {
    return localStorage.getItem("GEMINI_API_KEY") || "";
  });

  // Refs for audio/video processing
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioStreamerRef = useRef<AudioStreamer | null>(null);
  const sessionRef = useRef<any>(null); // Live API session
  const canvasRef = useRef<HTMLCanvasElement | null>(document.createElement("canvas"));

  const [ai] = useState(() => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" }));

  // --- Handlers ---

  // Add this state to track the session promise
  const [sessionPromise, setSessionPromise] = useState<Promise<any> | null>(null);

  const handleConnect = async () => {
    if (isConnected) {
      if (sessionRef.current) sessionRef.current.close();
      if (audioStreamerRef.current) audioStreamerRef.current.stop();
      if (processorNodeRef.current) processorNodeRef.current.disconnect();
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(t => t.stop());
      }
      setIsConnected(false);
      setIsMicOn(false);
      setIsVideoOn(false);
      setSessionPromise(null);
      setStatus("Disconnected");
      return;
    }

    try {
      setStatus("Connecting...");
      setError(null);
      setMessages([]);

      // Create a fresh instance of GoogleGenAI to ensure the latest key is used
      let currentApiKey = customApiKey || process.env.GEMINI_API_KEY || "";
      
      // If we're on the platform and no key is provided, try to open the selector
      if (!currentApiKey && window.aistudio) {
        setStatus("Awaiting API Key Selection...");
        await window.aistudio.openSelectKey();
        // Assuming the key is now in the environment as per docs
        currentApiKey = process.env.GEMINI_API_KEY || "";
      }

      if (!currentApiKey || currentApiKey === "MY_GEMINI_API_KEY") {
        setError("Gemini API Key is missing. Please click the gear icon to add one or check your secrets.");
        setStatus("Error");
        setShowSettings(true);
        return;
      }
      
      const genAI = new GoogleGenAI({ apiKey: currentApiKey });
      audioStreamerRef.current = new AudioStreamer();

      const promise = genAI.live.connect({
        model: "gemini-3.1-flash-live-preview",
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setStatus("Connected");
            console.log("Live API: Connection established");
            
            // Send an initial nudge to get the model talking
            promise.then(session => {
              session.sendRealtimeInput({ 
                text: "Hello Gemini! I want you to dictate the objects and people I show you. Start narrating and identifying everything you see in my camera feed right now." 
              });
            });
          },
          onmessage: async (message) => {
            console.log("Live API Message:", message);

            // Handle model output (Audio & Text)
            if (message.serverContent?.modelTurn) {
              const parts = message.serverContent.modelTurn.parts;
              if (parts) {
                parts.forEach(part => {
                  if (part.inlineData?.data && audioStreamerRef.current) {
                    audioStreamerRef.current.addChunk(part.inlineData.data);
                  }
                  if (part.text) {
                    setMessages(prev => [
                      ...prev, 
                      { id: Date.now().toString() + Math.random(), role: "model", text: part.text!, timestamp: new Date() }
                    ]);
                  }
                });
              }
            }

            // Handle user transcription
            if (message.serverContent?.userTurn) {
              const parts = message.serverContent.userTurn.parts;
              if (parts?.[0]?.text) {
                setMessages(prev => [
                  ...prev, 
                  { id: Date.now().toString() + "-user", role: "user", text: parts[0].text!, timestamp: new Date() }
                ]);
              }
            }

            // Handle interruptions
            if (message.serverContent?.interrupted) {
              console.warn("Live API: Model interrupted");
            }
          },
          onerror: (err) => {
            console.error("Live API Session Error:", err);
            setError(`Connection Error: ${err.message || 'Unknown error'}`);
            setIsConnected(false);
            setStatus("Error");
          },
          onclose: (closeEvent) => {
            console.log("Live API: Connection closed", closeEvent);
            setIsConnected(false);
            setStatus("Ready to connect");
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: {
            parts: [{
              text: "You are a specialized visual narration assistant. Your main job is to identify and DICTATE (speak out) exactly what objects and human beings you see in the video stream. Whenever a user shows an object or whenever a human appears, instantly name them and describe their actions or features concisely. Be proactive: if you see a person, say 'I see a person...'. If you see a phone, say 'That looks like a smartphone'. Focus heavily on real-time identification of items and people. Keep your narration brief, natural, and continuous as the visual scene changes."
            }]
          },
          inputAudioTranscription: {},
        },
      });

      setSessionPromise(promise);
      sessionRef.current = await promise;
    } catch (err: any) {
      setError(err.message || "Failed to connect to Gemini");
      setStatus("Error");
    }
  };

  const toggleMic = async () => {
    if (isMicOn) {
      if (processorNodeRef.current) {
        processorNodeRef.current.disconnect();
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getAudioTracks().forEach(t => t.stop());
      }
      setIsMicOn(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      
      const audioContext = new AudioContext({ sampleRate: 16000 });
      await audioContext.resume();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorNodeRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (!sessionPromise || !isMicOn) return;
        
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmBuffer = encodePCM16(inputData);
        const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcmBuffer)));
        
        sessionPromise.then(session => {
          session.sendRealtimeInput({
            audio: { data: base64Data, mimeType: "audio/pcm;rate=16000" }
          });
        }).catch(err => console.error("Mic Send Error:", err));
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      setIsMicOn(true);
      setError(null);
    } catch (err) {
      console.error("Microphone Error:", err);
      setError("Could not access microphone. Please check permissions.");
    }
  };

  const toggleVideo = async () => {
    if (isVideoOn) {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getVideoTracks().forEach(t => t.stop());
      }
      setIsVideoOn(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      
      // Store stream so we can stop it later
      if (mediaStreamRef.current) {
        stream.getAudioTracks().forEach(track => mediaStreamRef.current?.addTrack(track));
      } else {
        mediaStreamRef.current = stream;
      }

      setIsVideoOn(true);
    } catch (err) {
      setError("Could not access camera");
    }
  };

  // Frame sending loop for video
  useEffect(() => {
    let interval: number;
    if (isVideoOn && isConnected && sessionPromise) {
      interval = window.setInterval(() => {
        if (!videoRef.current || !canvasRef.current || videoRef.current.paused || videoRef.current.ended) return;
        
        const canvas = canvasRef.current;
        const video = videoRef.current;
        
        // Use a consistent small resolution for faster cloud processing
        canvas.width = 320; 
        canvas.height = 240; 
        
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const base64Data = canvas.toDataURL("image/jpeg", 0.5).split(",")[1];
          
          sessionPromise.then(session => {
            session.sendRealtimeInput({
              video: { data: base64Data, mimeType: "image/jpeg" }
            });
          }).catch(err => console.error("Video Send Error:", err));
        }
      }, 750); // Faster interval for more active dictation
    }
    return () => clearInterval(interval);
  }, [isVideoOn, isConnected, sessionPromise]);

  return (
    <div className="min-h-screen bg-[#050505] text-white font-sans selection:bg-blue-500/30">
      {/* Background Gradients */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-900/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-900/10 rounded-full blur-[120px]" />
      </div>

      {/* Main Content */}
      <main className="relative z-10 max-w-6xl mx-auto p-4 md:p-8 h-screen flex flex-col">
        {/* Header */}
        <header className="flex justify-between items-center mb-8">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-br from-blue-600 to-purple-600 rounded-xl shadow-lg shadow-blue-900/20">
              <Sparkles className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Gemini Live</h1>
              <p className="text-xs text-zinc-500 font-mono flex items-center gap-1.5 uppercase tracking-wider">
                <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-zinc-700'}`} />
                {status}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleConnect}
              className={`flex items-center gap-2 px-4 py-2 rounded-full font-medium transition-all ${
                isConnected 
                ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300' 
                : 'bg-white hover:bg-zinc-200 text-black shadow-lg shadow-white/5'
              }`}
            >
              <Power className="w-4 h-4" />
              {isConnected ? 'Disconnect' : 'Connect'}
            </button>
            <button 
              onClick={() => setShowSettings(!showSettings)}
              className={`p-2 transition-colors ${showSettings ? 'text-white bg-zinc-800 rounded-lg' : 'text-zinc-400 hover:text-white'}`}
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* API Key Modal / Settings */}
        <AnimatePresence>
          {showSettings && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            >
              <div className="bg-zinc-900 border border-white/10 rounded-3xl w-full max-w-md shadow-2xl overflow-hidden">
                <div className="p-6 border-b border-white/5 flex items-center justify-between">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Key className="w-5 h-5 text-blue-500" />
                    Settings
                  </h3>
                  <button onClick={() => setShowSettings(false)} className="text-zinc-500 hover:text-white transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div className="p-6 space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-zinc-400 mb-2">Gemini API Key</label>
                    <div className="relative">
                      <input 
                        type="password"
                        value={customApiKey}
                        onChange={(e) => {
                          setCustomApiKey(e.target.value);
                          localStorage.setItem("GEMINI_API_KEY", e.target.value);
                        }}
                        placeholder="Paste your API key here..."
                        className="w-full bg-zinc-950 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500/50 transition-colors"
                      />
                    </div>
                    <p className="mt-2 text-xs text-zinc-500">
                      Keys are stored locally in your browser. Get one at 
                      <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline inline-flex items-center gap-1 ml-1">
                        AI Studio <ExternalLink className="w-2 h-2" />
                      </a>
                    </p>
                  </div>

                  {window.aistudio && (
                    <div className="p-4 bg-blue-500/10 rounded-2xl border border-blue-500/20">
                      <p className="text-xs text-blue-300 leading-relaxed">
                        Detecting AI Studio Environment. You can also use the platform secret manager.
                      </p>
                      <button 
                        onClick={() => window.aistudio?.openSelectKey()}
                        className="mt-3 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors font-medium"
                      >
                        Select Platform Key
                      </button>
                    </div>
                  )}

                  <div className="pt-2">
                    <button 
                      onClick={() => setShowSettings(false)}
                      className="w-full bg-white text-black font-semibold py-3 rounded-xl hover:bg-zinc-200 transition-colors"
                    >
                      Save & Close
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Grid Layout */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-0 overflow-hidden mb-6">
          
          {/* Left Column: Visualizers & Controls */}
          <div className="lg:col-span-12 flex flex-col md:flex-row gap-6 h-full">
            
            {/* Multimodal Preview */}
            <div className="flex-1 relative bg-zinc-900/40 rounded-3xl border border-white/5 overflow-hidden flex flex-col">
              {/* Media View */}
              <div className="flex-1 relative flex items-center justify-center p-8">
                {isVideoOn ? (
                  <video 
                    ref={videoRef}
                    autoPlay 
                    playsInline 
                    muted
                    className="w-full h-full object-cover rounded-2xl shadow-2xl mirror"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-4 text-zinc-600">
                    <div className="p-8 bg-zinc-800/30 rounded-full">
                      {isMicOn ? (
                        <div className="flex gap-1 items-end h-8">
                          {[1, 2, 3, 4, 3, 2, 1].map((h, i) => (
                            <motion.div 
                              key={i}
                              animate={{ height: [`${h*20}%`, `${h*40}%`, `${h*10}%`] }}
                              transition={{ repeat: Infinity, duration: 0.5 + i * 0.1 }}
                              className="w-1.5 bg-blue-500 rounded-full"
                            />
                          ))}
                        </div>
                      ) : (
                        <VideoOff className="w-12 h-12 opacity-20" />
                      )}
                    </div>
                    <p className="text-sm font-medium">Camera off</p>
                  </div>
                )}

                {/* Overlays */}
                <div className="absolute bottom-6 left-6 right-6 flex justify-center gap-4">
                  <motion.button
                    whileTap={{ scale: 0.95 }}
                    onClick={toggleMic}
                    disabled={!isConnected}
                    className={`p-4 rounded-full transition-all ${
                      isMicOn ? 'bg-blue-600 text-white' : 'bg-zinc-800/80 text-zinc-400'
                    } disabled:opacity-50 disabled:cursor-not-allowed backdrop-blur-md border border-white/10`}
                  >
                    {isMicOn ? <Mic className="w-6 h-6" /> : <MicOff className="w-6 h-6" />}
                  </motion.button>
                  
                  <motion.button
                    whileTap={{ scale: 0.95 }}
                    onClick={toggleVideo}
                    disabled={!isConnected}
                    className={`p-4 rounded-full transition-all ${
                      isVideoOn ? 'bg-purple-600 text-white' : 'bg-zinc-800/80 text-zinc-400'
                    } disabled:opacity-50 disabled:cursor-not-allowed backdrop-blur-md border border-white/10`}
                  >
                    {isVideoOn ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
                  </motion.button>
                </div>
              </div>

              {/* Status Bar */}
              <div className="px-6 py-4 bg-zinc-900/60 border-t border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
                    <Monitor className="w-3.5 h-3.5" />
                    720p 30fps
                  </div>
                  <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
                    <Zap className="w-3.5 h-3.5" />
                    Low Latency
                  </div>
                </div>
                <div className="text-[10px] items-center gap-1.5 hidden sm:flex text-blue-400 font-mono uppercase tracking-widest bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                  Processing Live
                </div>
              </div>
            </div>

            {/* Chat/Transcription Panel */}
            <div className="w-full md:w-96 bg-zinc-900/40 rounded-3xl border border-white/5 flex flex-col h-full overflow-hidden">
              <div className="p-6 border-b border-white/5 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-blue-500" />
                  Live Transcript
                </h2>
                <div className="w-2 h-2 rounded-full bg-zinc-700" />
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-hide">
                <AnimatePresence initial={false}>
                  {messages.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center p-8 gap-4 opacity-30">
                      <div className="p-4 bg-zinc-800 rounded-2xl">
                        <Volume2 className="w-8 h-8" />
                      </div>
                      <p className="text-sm">Speak to start the conversation</p>
                    </div>
                  ) : (
                    messages.map((msg) => (
                      <motion.div
                        key={msg.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
                      >
                        <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-1.5">
                          {msg.role === 'user' ? 'You' : 'Gemini'}
                        </span>
                        <div className={`
                          px-4 py-2.5 rounded-2xl text-sm leading-relaxed max-w-[90%]
                          ${msg.role === 'user' 
                            ? 'bg-zinc-800 text-zinc-100 rounded-tr-none' 
                            : 'bg-white/5 text-zinc-300 rounded-tl-none border border-white/10'}
                        `}>
                          {msg.text}
                        </div>
                      </motion.div>
                    ))
                  )}
                </AnimatePresence>
              </div>
            </div>

          </div>
        </div>

        {/* Error Notification */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="fixed bottom-8 left-1/2 -translate-x-1/2 p-4 bg-red-500 text-white rounded-2xl shadow-2xl shadow-red-900/40 flex items-center gap-3 z-50 min-w-[320px]"
            >
              <AlertCircle className="w-6 h-6 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium">{error}</p>
              </div>
              <button onClick={() => setError(null)} className="p-1 hover:bg-white/20 rounded-lg transition-colors">
                <Info className="w-4 h-4 rotate-180" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Footer */}
        <footer className="py-6 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-[0.2em]">
            Powered by Gemini 1.5 Flash Live
          </p>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
              Voice: Zephyr
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
              Latency: 120ms
            </div>
          </div>
        </footer>
      </main>

      <style>{`
        .mirror {
          transform: scaleX(-1);
        }
        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }
        .scrollbar-hide {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>
    </div>
  );
}

