// services/stream-service.js
// -------------------------------------------------------------
// Manages chunk ordering and delivery of TTS audio to Twilio.
// After an interruption we can call resetAfterClear() so that
// stale, never-to-be-played chunks do not block future audio.

require('dotenv').config();

const EventEmitter = require('events');
const uuid         = require('uuid');

class StreamService extends EventEmitter {
  constructor (websocket) {
    super();
    this.ws                 = websocket;
    this.expectedAudioIndex = 0;   // next index Twilio should hear
    this.audioBuffer        = {};  // out-of-order chunks wait here
    this.streamSid          = '';  // Twilio media stream identifier
  }

  /* attach Twilio’s streamSid to every outbound frame */
  setStreamSid (streamSid) {
    this.streamSid = streamSid;
  }

  /* push a new chunk; play immediately or buffer until in-order */
  buffer (index, audio) {
    if (index === null) {
      /* greeting chunk = no ordering, just send */
      this.sendAudio(audio);
    } else if (index === this.expectedAudioIndex) {
      /* correct order → play and flush any queued followers */
      this.sendAudio(audio);
      this.expectedAudioIndex++;

      while (Object.prototype.hasOwnProperty.call(this.audioBuffer, this.expectedAudioIndex)) {
        const bufferedAudio = this.audioBuffer[this.expectedAudioIndex];
        delete this.audioBuffer[this.expectedAudioIndex];
        this.sendAudio(bufferedAudio);
        this.expectedAudioIndex++;
      }
    } else {
      /* arrived early – keep for later */
      this.audioBuffer[index] = audio;
    }
  }

  /* low-level: emit media + mark frames to Twilio */
  sendAudio (audio) {
    /* media */
    this.ws.send(
      JSON.stringify({
        streamSid: this.streamSid,
        event:     'media',
        media:     { payload: audio }
      })
    );

    /* completion <mark> */
    const markLabel = uuid.v4();
    this.ws.send(
      JSON.stringify({
        streamSid: this.streamSid,
        event:     'mark',
        mark:      { name: markLabel }
      })
    );

    /* notify app logic */
    this.emit('audiosent', markLabel);
  }

  /* ───────────────────────────────────────────────────────────
     Called from app.js immediately after sending
       { event:'clear' }
     to Twilio.  All queued audio was just flushed by Twilio, so
     any chunks we stored (or expected <mark>s for) are now moot.
  ─────────────────────────────────────────────────────────── */
  resetAfterClear () {
    this.audioBuffer = {};   // drop orphaned chunks
    // expectedAudioIndex stays untouched so future chunks
    // continue with a monotonic sequence.
  }
}

module.exports = { StreamService };
