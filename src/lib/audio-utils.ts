/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Simple PCM-16 encoding
export function encodePCM16(buffer: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    const s = Math.max(-1, Math.min(1, buffer[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm.buffer;
}

// Simple PCM-16 decoding
export function decodePCM16(buffer: ArrayBuffer): Float32Array {
  const pcm = new Int16Array(buffer);
  const audio = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    audio[i] = pcm[i] / 0x8000;
  }
  return audio;
}

export class AudioStreamer {
  private audioContext: AudioContext;
  private nextStartTime: number = 0;
  private readonly sampleRate: number = 24000;

  constructor() {
    this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
  }

  private async ensureAudioContext() {
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  async addChunk(base64Data: string) {
    try {
      await this.ensureAudioContext();
      const buffer = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0)).buffer;
      const float32Data = decodePCM16(buffer);
      
      const audioBuffer = this.audioContext.createBuffer(1, float32Data.length, this.sampleRate);
      audioBuffer.getChannelData(0).set(float32Data);
      
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);
      
      const startTime = Math.max(this.audioContext.currentTime, this.nextStartTime);
      source.start(startTime);
      this.nextStartTime = startTime + audioBuffer.duration;
    } catch (e) {
      console.error("AudioStreamer Error:", e);
    }
  }

  stop() {
    this.audioContext.close();
  }
}
