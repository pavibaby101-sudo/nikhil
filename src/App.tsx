/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, MicOff, MessageSquare, Settings, LogIn, LogOut, Volume2, VolumeX, Sparkles } from 'lucide-react';
import { auth, db } from './firebase';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from 'firebase/auth';
import { getConversationHistory, saveMessage, generateResponse, generateSpeech, learnFromInteraction, Message } from './services/geminiService';
import Markdown from 'react-markdown';
import { doc, onSnapshot } from 'firebase/firestore';

// Audio helper to play Gemini TTS PCM data
async function playPCM(base64Data: string) {
  const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
  const audioContext = new AudioContextClass({ sampleRate: 24000 });
  
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const binaryString = atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  // PCM 16-bit Little Endian
  const int16Data = new Int16Array(bytes.buffer);
  const float32Data = new Float32Array(int16Data.length);
  for (let i = 0; i < int16Data.length; i++) {
    float32Data[i] = int16Data[i] / 32768.0;
  }

  const buffer = audioContext.createBuffer(1, float32Data.length, 24000);
  buffer.getChannelData(0).set(float32Data);

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.start();
  
  return new Promise((resolve) => {
    source.onended = () => {
      audioContext.close();
      resolve(true);
    };
  });
}

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [learnedFacts, setLearnedFacts] = useState<string[]>([]);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [useTurboVoice, setUseTurboVoice] = useState(true); // Default to Turbo for speed
  const [isAutoListen, setIsAutoListen] = useState(true); // Default to true
  const [messages, setMessages] = useState<Message[]>([]);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  
  // Refs for state to be used in event listeners
  const isAutoListenRef = useRef(true);
  const isProcessingRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const isListeningRef = useRef(false);

  useEffect(() => { isAutoListenRef.current = isAutoListen; }, [isAutoListen]);
  useEffect(() => { isProcessingRef.current = isProcessing; }, [isProcessing]);
  useEffect(() => { isSpeakingRef.current = isSpeaking; }, [isSpeaking]);
  useEffect(() => { isListeningRef.current = isListening; }, [isListening]);

  // Browser Speech Synthesis
  const speakBrowser = (text: string) => {
    return new Promise((resolve) => {
      // Cancel any ongoing speech
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.1; 
      utterance.pitch = 1.0;
      
      const setVoice = () => {
        const voices = window.speechSynthesis.getVoices();
        // Prefer a natural sounding English voice
        const preferredVoice = voices.find(v => (v.name.includes('Google') || v.name.includes('Natural')) && v.lang.includes('en')) || 
                               voices.find(v => v.lang.includes('en')) || 
                               voices[0];
        if (preferredVoice) utterance.voice = preferredVoice;
      };

      setVoice();
      // If voices aren't loaded yet, they might load soon
      if (window.speechSynthesis.getVoices().length === 0) {
        window.speechSynthesis.onvoiceschanged = setVoice;
      }

      utterance.onend = () => {
        resolve(true);
      };
      utterance.onerror = (e) => {
        console.error('SpeechSynthesis error', e);
        resolve(true);
      };

      window.speechSynthesis.speak(utterance);
      
      // Chrome bug: long utterances can time out. Resume every 10s if needed.
      const resumeInterval = setInterval(() => {
        if (!window.speechSynthesis.speaking) {
          clearInterval(resumeInterval);
        } else {
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        }
      }, 10000);
    });
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setUser(user);
      setIsAuthReady(true);
      if (user) {
        const history = await getConversationHistory(user.uid);
        setMessages(history);

        const unsubProfile = onSnapshot(doc(db, "users", user.uid), (doc) => {
          if (doc.exists()) {
            setLearnedFacts(doc.data().learnedFacts || []);
          }
        });
        return () => unsubProfile();
      } else {
        setMessages([]);
        setLearnedFacts([]);
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, transcript]);

  // Initialize Speech Recognition
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onresult = (event: any) => {
        const current = event.resultIndex;
        const result = event.results[current];
        const text = result[0].transcript;
        setTranscript(text);
        
        if (result.isFinal) {
          handleUserMessage(text);
        }
      };

      recognition.onerror = (event: any) => {
        console.error('Speech recognition error', event.error);
        setIsListening(false);
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          setError(`Microphone error: ${event.error}`);
        }
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    } else {
      setError('Speech recognition is not supported in this browser.');
    }
  }, [user]);

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error('Login failed', err);
      setError('Login failed. Please try again.');
    }
  };

  const handleLogout = () => signOut(auth);

  const toggleListening = async () => {
    if (!user) {
      handleLogin();
      return;
    }

    // Ensure AudioContext is resumed/initialized on user interaction
    const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
    const tempCtx = new AudioContextClass();
    if (tempCtx.state === 'suspended') await tempCtx.resume();
    tempCtx.close();

    if (isListening) {
      recognitionRef.current?.stop();
    } else {
      setTranscript('');
      setError(null);
      try {
        recognitionRef.current?.start();
      } catch (e) {
        console.warn('Recognition already started');
      }
    }
  };

  // Watchdog: Ensure recognition is running in Hands-free mode
  useEffect(() => {
    if (isAutoListen && user && !isProcessing && !isSpeaking && !isListening && recognitionRef.current) {
      const timer = setTimeout(() => {
        // Double check state before starting
        if (isAutoListen && !isProcessing && !isSpeaking && !isListening) {
          try {
            recognitionRef.current.start();
          } catch (e) {
            // Might already be starting or started
          }
        }
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [isAutoListen, isProcessing, isSpeaking, isListening, user]);

  const handleUserMessage = async (text: string) => {
    if (!user || !text.trim()) return;

    setIsProcessing(true);
    try {
      await saveMessage(user.uid, 'user', text);
      const updatedHistory = [...messages, { role: 'user', content: text, timestamp: new Date() } as Message];
      setMessages(updatedHistory);
      setTranscript('');

      const responseText = await generateResponse(user.uid, text, messages);
      
      await saveMessage(user.uid, 'model', responseText);
      setMessages(prev => [...prev, { role: 'model', content: responseText, timestamp: new Date() } as Message]);

      // Background learning task
      learnFromInteraction(user.uid, text, responseText);

      setIsSpeaking(true);
      
      let speechSuccess = false;
      if (useTurboVoice && window.speechSynthesis) {
        try {
          await speakBrowser(responseText);
          speechSuccess = true;
        } catch (e) {
          console.warn('Turbo voice failed, falling back to Gemini TTS', e);
        }
      }

      if (!speechSuccess) {
        const audioData = await generateSpeech(responseText);
        if (audioData) {
          await playPCM(audioData);
        }
      }
    } catch (err) {
      console.error('Error processing message', err);
      setError('Something went wrong. Please try again.');
    } finally {
      setIsProcessing(false);
      setIsSpeaking(false);
      
      // Recognition will auto-restart via onend listener
    }
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-bg-dark flex items-center justify-center">
        <motion.div 
          animate={{ scale: [1, 1.1, 1], opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="w-12 h-12 rounded-full bg-accent blur-xl"
        />
      </div>
    );
  }

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content;
  const lastModelMsg = [...messages].reverse().find(m => m.role === 'model')?.content;

  return (
    <div className="flex h-screen w-full bg-bg-dark text-text-main font-sans overflow-hidden">
      {/* Left Sidebar: Memory Engine */}
      <aside className="w-72 border-r border-border-dim p-8 flex flex-col gap-8 bg-gradient-to-b from-bg-dark to-[#0d0d0d]">
        <div className="flex-1 flex flex-col gap-8 overflow-hidden">
          <div className="flex flex-col h-1/2">
            <span className="text-[10px] uppercase tracking-[0.15em] text-text-dim mb-4 block">Recent Interactions</span>
            <div className="space-y-3 overflow-y-auto scrollbar-hide flex-1" ref={scrollRef}>
              {messages.length === 0 ? (
                <div className="p-4 bg-bg-surface border border-border-dim rounded-lg opacity-50">
                  <p className="text-xs text-text-dim italic">No memories recorded yet.</p>
                </div>
              ) : (
                messages.slice(-10).map((msg, i) => (
                  <div key={i} className="bg-bg-surface border border-border-dim rounded-lg p-3">
                    <h4 className="text-[13px] font-medium mb-1 capitalize">{msg.role === 'user' ? 'You' : 'Aura'}</h4>
                    <p className="text-[12px] text-text-dim line-clamp-2 leading-relaxed">{msg.content}</p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="flex flex-col h-1/2">
            <span className="text-[10px] uppercase tracking-[0.15em] text-text-dim mb-4 block">Learned Context</span>
            <div className="space-y-2 overflow-y-auto scrollbar-hide flex-1">
              {learnedFacts.length === 0 ? (
                <p className="text-[11px] text-text-dim italic opacity-50">Aura is still learning about you...</p>
              ) : (
                learnedFacts.map((fact, i) => (
                  <motion.div 
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    key={i} 
                    className="text-[11px] text-text-dim flex gap-2 items-start"
                  >
                    <span className="text-accent mt-1">•</span>
                    <span>{fact}</span>
                  </motion.div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="mt-auto pt-4 border-t border-border-dim space-y-4">
          <div className="space-y-2">
            <span className="text-[10px] uppercase tracking-[0.15em] text-text-dim block">Voice Engine</span>
            <div className="flex items-center justify-between p-3 bg-bg-surface border border-border-dim rounded-lg">
              <span className="text-[11px] font-medium">Turbo Mode</span>
              <button 
                onClick={() => setUseTurboVoice(!useTurboVoice)}
                className={`w-10 h-5 rounded-full transition-colors relative ${useTurboVoice ? 'bg-accent' : 'bg-white/10'}`}
              >
                <motion.div 
                  animate={{ x: useTurboVoice ? 20 : 2 }}
                  className="absolute top-1 w-3 h-3 bg-white rounded-full shadow-sm"
                />
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <span className="text-[10px] uppercase tracking-[0.15em] text-text-dim block">Interaction Mode</span>
            <div className="flex items-center justify-between p-3 bg-bg-surface border border-border-dim rounded-lg">
              <span className="text-[11px] font-medium">Hands-free</span>
              <button 
                onClick={() => setIsAutoListen(!isAutoListen)}
                className={`w-10 h-5 rounded-full transition-colors relative ${isAutoListen ? 'bg-accent' : 'bg-white/10'}`}
              >
                <motion.div 
                  animate={{ x: isAutoListen ? 20 : 2 }}
                  className="absolute top-1 w-3 h-3 bg-white rounded-full shadow-sm"
                />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Center: Main Interaction */}
      <main className="flex-1 flex flex-col relative">
        <header className="p-10 flex justify-between items-center">
          <div className="text-lg font-bold tracking-tighter">
            AETHER<span className="text-accent">.</span>
          </div>
          
          <div className="flex items-center gap-6">
            <AnimatePresence>
              {(isListening || isProcessing || isSpeaking) && (
                <motion.div 
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  className="bg-accent-soft border border-accent text-accent px-3 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider"
                >
                  {isListening ? 'Listening...' : isProcessing ? 'Processing...' : 'Speaking...'}
                </motion.div>
              )}
            </AnimatePresence>

            {user ? (
              <button onClick={handleLogout} className="text-[10px] uppercase tracking-widest text-text-dim hover:text-white transition-colors">
                Sign Out
              </button>
            ) : (
              <button onClick={handleLogin} className="text-[10px] uppercase tracking-widest text-accent hover:text-white transition-colors">
                Initialize
              </button>
            )}
          </div>
        </header>

        <section className="flex-1 flex flex-col items-center justify-center px-16 pb-10">
          <div className="relative w-60 h-60 mb-12 flex items-center justify-center">
            {/* Orb Rings */}
            <div className="absolute w-[220px] h-[220px] border border-border-dim rounded-full" />
            <div className="absolute w-[180px] h-[180px] border border-white/5 rounded-full" />
            
            {/* The Orb */}
            <motion.div
              animate={{
                scale: isSpeaking ? [1, 1.1, 1] : isListening ? [1, 1.05, 1] : 1,
                opacity: isProcessing ? [0.6, 1, 0.6] : 1,
              }}
              transition={{
                duration: 0.8,
                repeat: Infinity,
                ease: "easeInOut"
              }}
              className="w-36 h-36 rounded-full orb-glow shadow-[0_0_80px_rgba(99,102,241,0.2)] relative"
            >
              <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-accent/20 to-transparent" />
            </motion.div>

            {/* Mic Button Overlay */}
            <button 
              onClick={toggleListening}
              className="absolute z-10 p-4 rounded-full hover:bg-white/5 transition-colors group"
            >
              {isListening ? (
                <MicOff size={32} className="text-red-400" />
              ) : (
                <Mic size={32} className="text-white/40 group-hover:text-white transition-colors" />
              )}
            </button>
          </div>

          <div className="text-center max-w-2xl">
            <AnimatePresence mode="wait">
              {transcript || lastUserMsg ? (
                <motion.div 
                  key="query"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-lg text-text-dim mb-4 font-normal italic"
                >
                  "{transcript || lastUserMsg}"
                </motion.div>
              ) : null}
            </AnimatePresence>

            <motion.div 
              key="response"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-3xl font-medium leading-tight text-white"
            >
              {isProcessing ? (
                <span className="opacity-30 animate-pulse">Analyzing request...</span>
              ) : (
                lastModelMsg || "Awaiting your command, " + (user?.displayName?.split(' ')[0] || "User") + "."
              )}
            </motion.div>
          </div>
        </section>

        <footer className="p-10 border-t border-border-dim text-[11px] text-text-dim flex gap-6 uppercase tracking-widest">
          <span>Latency: {isProcessing ? 'Calculating...' : '142ms'}</span>
          <span>Mood: {isSpeaking ? 'Expressive' : 'Analytical'}</span>
          <span>Confidence: 98.4%</span>
        </footer>
      </main>

      {/* Right Panel: Technical Context */}
      <aside className="w-80 p-8 border-l border-border-dim bg-black/50 backdrop-blur-sm">
        <span className="text-[10px] uppercase tracking-[0.15em] text-text-dim mb-6 block">Contextual Analysis</span>
        
        <div className="pb-6 mb-6 border-b border-border-dim space-y-3">
          <div className="flex justify-between text-xs">
            <span className="text-text-dim">User State</span>
            <span className="font-medium">{user ? 'Authenticated' : 'Guest'}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-text-dim">Ambient Noise</span>
            <span className="font-medium">22dB (Quiet)</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-text-dim">Location</span>
            <span className="font-medium">Home Office</span>
          </div>
        </div>

        <span className="text-[10px] uppercase tracking-[0.15em] text-text-dim mb-4 block">Acoustic Signature</span>
        <div className="h-10 flex items-center gap-[3px] mb-10">
          {[12, 28, 18, 36, 14, 28, 12, 36, 18, 14, 12, 28, 36, 18].map((h, i) => (
            <motion.div 
              key={i}
              animate={{ height: isSpeaking || isListening ? [h, h * 0.5, h] : h }}
              transition={{ duration: 0.5, repeat: Infinity, delay: i * 0.05 }}
              className="w-[3px] bg-accent rounded-sm opacity-60"
              style={{ height: h }}
            />
          ))}
        </div>

        <div>
          <span className="text-[10px] uppercase tracking-[0.15em] text-text-dim mb-4 block">Inferred Next Actions</span>
          <div className="flex flex-col gap-3">
            <div className="text-[12px] p-3 border border-dashed border-border-dim rounded-md opacity-70 hover:opacity-100 transition-opacity cursor-pointer">
              Review conversation logs
            </div>
            <div className="text-[12px] p-3 border border-dashed border-border-dim rounded-md opacity-70 hover:opacity-100 transition-opacity cursor-pointer">
              Update user preferences
            </div>
            <div className="text-[12px] p-3 border border-dashed border-border-dim rounded-md opacity-70 hover:opacity-100 transition-opacity cursor-pointer">
              Initiate deep learning sync
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}


