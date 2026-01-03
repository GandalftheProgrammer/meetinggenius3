
import React, { useState, useEffect, useRef } from 'react';
import Header from './components/Header';
import Recorder from './components/Recorder';
import Results from './components/Results';
import { AppState, MeetingData, ProcessingMode, GeminiModel } from './types';
import { processMeetingAudio } from './services/geminiService';
import { initDrive, connectToDrive, uploadAudioToDrive, uploadTextToDrive, disconnectDrive } from './services/driveService';
import { saveChunkToDB, getChunksForSession, getPendingSessions, deleteSessionData } from './services/db';
import { AlertCircle, RotateCcw } from 'lucide-react';

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [title, setTitle] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<GeminiModel>('gemini-2.5-flash-lite');
  const [lastRequestedMode, setLastRequestedMode] = useState<ProcessingMode>('NOTES_ONLY');
  
  const [meetingData, setMeetingData] = useState<MeetingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // FIX: Use useRef for audio chunks to avoid massive re-renders and memory leaks
  const audioChunksRef = useRef<Blob[]>([]);
  const sessionIdRef = useRef<string>(`session_${Date.now()}`);
  
  const [combinedBlob, setCombinedBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  
  const [isDriveConnected, setIsDriveConnected] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [sessionStartTime, setSessionStartTime] = useState<Date | null>(null);
  
  // Recovery State
  const [recoverableSession, setRecoverableSession] = useState<{sessionId: string, title: string} | null>(null);

  const addLog = (msg: string) => {
    setDebugLogs(prev => [...prev, `${new Date().toLocaleTimeString('en-GB')} - ${msg}`]);
  };

  const formatMeetingDateTime = (date: Date) => {
    const day = date.getDate();
    const months = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${day} ${month} ${year} at ${hours}h${minutes}m`;
  };

  useEffect(() => {
    // Check for recoverable sessions on mount
    const checkRecovery = async () => {
        const sessions = await getPendingSessions();
        if (sessions.length > 0) {
            setRecoverableSession(sessions[0]);
        }
    };
    checkRecovery();

    const timer = setTimeout(() => {
      initDrive((token) => {
          if (token) {
              setIsDriveConnected(true);
              addLog("Drive link active.");
          } else {
              setIsDriveConnected(false);
          }
      });
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  const handleConnectDrive = () => {
      const storedName = localStorage.getItem('drive_folder_name');
      if (storedName) {
          connectToDrive();
      } else {
          const folderName = prompt("Drive folder name?", "MeetingGenius");
          if (folderName) {
              localStorage.setItem('drive_folder_name', folderName);
              connectToDrive();
          }
      }
  };

  const handleDisconnectDrive = () => {
    disconnectDrive();
    setIsDriveConnected(false);
    addLog("Drive disconnected.");
  };

  const handleChunkReady = (chunk: Blob) => {
    audioChunksRef.current.push(chunk);
    
    // Persistent backup to IndexedDB for crash recovery
    saveChunkToDB({
        sessionId: sessionIdRef.current,
        index: audioChunksRef.current.length,
        chunk: chunk,
        timestamp: Date.now()
    }).catch(err => console.error("Failed to save chunk to DB:", err));
  };

  const finalizeAudio = () => {
    if (audioChunksRef.current.length > 0) {
      const mimeType = audioChunksRef.current[0].type || 'audio/webm';
      const blob = new Blob(audioChunksRef.current, { type: mimeType });
      setCombinedBlob(blob);
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
    }
  };

  const handleFileUpload = (file: File) => {
      audioChunksRef.current = [];
      setCombinedBlob(file);
      const url = URL.createObjectURL(file);
      setAudioUrl(url);
      setAppState(AppState.PAUSED);
      setSessionStartTime(new Date(file.lastModified));
      addLog(`File received: ${file.name}`);
      if (!title) {
          setTitle(file.name.replace(/\.[^/.]+$/, ""));
      }
  };

  const handleRecordingChange = (isRecording: boolean) => {
    if (isRecording) {
      // Starting fresh
      sessionIdRef.current = `session_${Date.now()}`;
      audioChunksRef.current = [];
      setSessionStartTime(new Date());
      setAppState(AppState.RECORDING);
      setRecoverableSession(null); // Clear recovery prompt if user starts a new one
    } else {
       if (appState === AppState.RECORDING) {
         setAppState(AppState.PAUSED);
         finalizeAudio(); // Glue audio only when recording stops
       }
    }
  };

  const restoreSession = async () => {
      if (!recoverableSession) return;
      addLog("Restoring session from backup...");
      try {
          const chunks = await getChunksForSession(recoverableSession.sessionId);
          if (chunks.length > 0) {
              audioChunksRef.current = chunks;
              sessionIdRef.current = recoverableSession.sessionId;
              setTitle(recoverableSession.title || "");
              finalizeAudio();
              setAppState(AppState.PAUSED);
              setRecoverableSession(null);
              addLog(`Restored ${chunks.length} segments.`);
          }
      } catch (err) {
          addLog("Restoration failed.");
          setRecoverableSession(null);
      }
  };

  const discardRecovery = async () => {
      if (recoverableSession) {
          await deleteSessionData(recoverableSession.sessionId);
          setRecoverableSession(null);
      }
  };

  const autoSyncToDrive = async (data: MeetingData, currentTitle: string, blob: Blob | null) => {
    if (!isDriveConnected) return;
    
    const startTime = sessionStartTime || new Date();
    const dateString = formatMeetingDateTime(startTime);
    const cleanTitle = currentTitle.replace(/[()]/g, '').trim();
    
    const safeBaseName = `${cleanTitle} on ${dateString}`.replace(/[/\\?%*:|"<>]/g, '-');

    addLog(`Cloud Storage: Syncing...`);

    if (blob) {
      let ext = 'webm';
      const type = blob.type.toLowerCase();
      if (type.includes('mp4') || type.includes('m4a')) ext = 'm4a';
      else if (type.includes('wav')) ext = 'wav';
      else if (type.includes('mp3')) ext = 'mp3';
      const audioName = `${safeBaseName} - audio.${ext}`;
      uploadAudioToDrive(audioName, blob).catch(() => {});
    }

    if (data.summary || data.actionItems.length > 0) {
      const notesName = `${safeBaseName} - notes`;
      let notesMarkdown = `# ${cleanTitle} notes\n`;
      notesMarkdown += `*Recorded on ${dateString}*\n\n`;
      notesMarkdown += `${data.summary.trim()}\n\n`;
      if (data.conclusions && data.conclusions.length > 0) {
          notesMarkdown += `## Conclusions & Insights\n${data.conclusions.map(i => `- ${i}`).join('\n')}\n`;
      }
      if (data.actionItems && data.actionItems.length > 0) {
          notesMarkdown += `\n## Action Items${data.actionItems.map(i => `- ${i}`).join('\n')}`;
      }
      uploadTextToDrive(notesName, notesMarkdown, 'Notes').catch(() => {});
    }

    if (data.transcription) {
      const transcriptName = `${safeBaseName} - transcription`;
      let transcriptMarkdown = `# ${cleanTitle} transcript\n`;
      transcriptMarkdown += `*Recorded on ${dateString}*\n\n${data.transcription.trim()}`;
      uploadTextToDrive(transcriptName, transcriptMarkdown, 'Transcripts').catch(() => {});
    }
  };

  const handleProcessAudio = async (mode: ProcessingMode) => {
    if (!combinedBlob) return;
    
    setLastRequestedMode(mode);
    let finalTitle = title.trim() || "Meeting";
    setTitle(finalTitle);

    setAppState(AppState.PROCESSING);

    try {
      addLog("Starting analysis...");
      const newData = await processMeetingAudio(combinedBlob, combinedBlob.type || 'audio/webm', 'ALL', selectedModel, addLog);
      
      setMeetingData(newData);
      setAppState(AppState.COMPLETED);

      // Processing complete: Clear backup
      deleteSessionData(sessionIdRef.current).catch(() => {});

      if (isDriveConnected) {
        autoSyncToDrive(newData, finalTitle, combinedBlob);
      }
    } catch (apiError) {
      addLog(`Error: ${apiError instanceof Error ? apiError.message : 'Unknown'}`);
      setError("Analysis failed.");
      setAppState(AppState.PAUSED); 
    }
  };

  const handleDiscard = async () => {
    // Clear everything
    await deleteSessionData(sessionIdRef.current);
    
    setAppState(AppState.IDLE);
    audioChunksRef.current = [];
    setCombinedBlob(null);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setMeetingData(null);
    setDebugLogs([]);
    setTitle("");
    setError(null);
    setSessionStartTime(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <Header 
        isDriveConnected={isDriveConnected} 
        onConnectDrive={handleConnectDrive} 
        onDisconnectDrive={handleDisconnectDrive}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
      />
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 md:px-6 py-8 md:py-12">
        {error && (
          <div className="max-w-md mx-auto mb-8 p-4 bg-red-50 border border-red-100 text-red-600 rounded-xl text-center text-sm font-medium">
            {error}
          </div>
        )}

        {recoverableSession && appState === AppState.IDLE && (
            <div className="max-w-lg mx-auto mb-8 bg-blue-600 text-white p-4 rounded-2xl shadow-lg flex items-center justify-between animate-in slide-in-from-top-4 duration-500">
                <div className="flex items-center gap-3">
                    <div className="bg-blue-500 p-2 rounded-full">
                        <AlertCircle className="w-5 h-5 text-white" />
                    </div>
                    <div>
                        <p className="font-bold text-sm">Unsaved session found!</p>
                        <p className="text-xs text-blue-100 opacity-90 italic">"{recoverableSession.title || 'Untitled'}"</p>
                    </div>
                </div>
                <div className="flex gap-2">
                    <button onClick={restoreSession} className="bg-white text-blue-600 px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-blue-50 transition-colors flex items-center gap-1">
                        <RotateCcw className="w-3 h-3" />
                        Restore
                    </button>
                    <button onClick={discardRecovery} className="bg-blue-700 text-blue-200 px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-blue-800 transition-colors">
                        Ignore
                    </button>
                </div>
            </div>
        )}

        {appState !== AppState.COMPLETED && (
          <div className="flex flex-col items-center space-y-8 animate-in fade-in duration-500">
            <div className="w-full max-w-lg space-y-2">
              <label htmlFor="title" className="block text-sm font-semibold text-slate-600 ml-1">Meeting Title</label>
              <input
                type="text"
                id="title"
                value={title}
                onChange={(e) => {
                    setTitle(e.target.value);
                    localStorage.setItem(`title_${sessionIdRef.current}`, e.target.value);
                }}
                placeholder="Meeting Title"
                className="w-full px-4 py-3 rounded-xl border border-slate-200 shadow-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                disabled={appState === AppState.PROCESSING || appState === AppState.RECORDING}
              />
            </div>
            <Recorder 
              appState={appState}
              onChunkReady={handleChunkReady}
              onProcessAudio={handleProcessAudio}
              onDiscard={handleDiscard}
              onRecordingChange={handleRecordingChange}
              onFileUpload={handleFileUpload}
              audioUrl={audioUrl}
              debugLogs={debugLogs}
            />
          </div>
        )}
        {appState === AppState.COMPLETED && meetingData && (
          <Results 
            data={meetingData} 
            title={title} 
            onReset={handleDiscard}
            onGenerateMissing={() => {}} 
            isProcessingMissing={false}
            isDriveConnected={isDriveConnected}
            onConnectDrive={handleConnectDrive}
            audioBlob={combinedBlob}
            initialMode={lastRequestedMode}
            sessionDateString={sessionStartTime ? formatMeetingDateTime(sessionStartTime) : formatMeetingDateTime(new Date())}
          />
        )}
      </main>
      <footer className="py-6 text-center text-slate-400 text-xs font-medium tracking-wide uppercase">
        MeetingGenius Cloud
      </footer>
    </div>
  );
};

export default App;
