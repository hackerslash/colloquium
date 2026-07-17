import { useEffect, useRef } from 'react';

export function useRingtone(type: 'incoming' | 'outgoing' | null) {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  useEffect(() => {
    if (!type) {
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
      return;
    }

    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      // A context created with no preceding user gesture can start suspended
      // (autoplay policy) — the graph below would then schedule silently with
      // no audible ring and no error. Resuming is a no-op if already running.
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});

      const gainNode = ctx.createGain();
      gainNode.connect(ctx.destination);
      gainNode.gain.value = 0;
      gainNodeRef.current = gainNode;

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      
      if (type === 'incoming') {
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.setValueAtTime(480, ctx.currentTime + 0.5);
      } else {
        osc.frequency.setValueAtTime(400, ctx.currentTime);
        osc.frequency.setValueAtTime(450, ctx.currentTime + 1.5);
      }
      
      osc.connect(gainNode);
      osc.start();
      oscillatorRef.current = osc;

      const playRing = () => {
        if (!audioCtxRef.current) return;
        const now = audioCtxRef.current.currentTime;
        
        if (type === 'incoming') {
          // Double ring pattern
          gainNode.gain.setValueAtTime(0, now);
          gainNode.gain.linearRampToValueAtTime(0.5, now + 0.1);
          gainNode.gain.linearRampToValueAtTime(0, now + 0.4);
          
          gainNode.gain.setValueAtTime(0, now + 0.5);
          gainNode.gain.linearRampToValueAtTime(0.5, now + 0.6);
          gainNode.gain.linearRampToValueAtTime(0, now + 0.9);
          
          timeoutRef.current = setTimeout(playRing, 3000);
        } else {
          // Long ring pattern
          gainNode.gain.setValueAtTime(0, now);
          gainNode.gain.linearRampToValueAtTime(0.2, now + 0.1);
          gainNode.gain.linearRampToValueAtTime(0.2, now + 1.9);
          gainNode.gain.linearRampToValueAtTime(0, now + 2.0);
          
          timeoutRef.current = setTimeout(playRing, 4000);
        }
      };

      playRing();

    } catch (e) {
      console.warn("AudioContext not supported or blocked");
    }

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
    };
  }, [type]);
}
