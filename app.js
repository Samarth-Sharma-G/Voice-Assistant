// app.js  – main Node entry (Twilio media + RAG + escalation + interrupt)
// -----------------------------------------------------------------------------
// ❶  Handles call audio: Twilio ⇒ Deepgram ⇒ GPT ⇒ TTS ⇒ Twilio
// ❷  Adds Retrieval-Augmented context (Weaviate) before each GPT call
// ❸  Detects escalation intent via the RAG service and, if flagged, forwards
//     the live call to ESCALATION_NUMBER
// ❹  Keeps the “assistantTalking” clear/stop logic so the bot never talks over
//     the caller or answers an old question after an interruption.
// ➎  Passes the caller number via <Parameter> in the <Stream> start frame,
//     making extraction rock-solid.
// -----------------------------------------------------------------------------

require('dotenv').config();
require('colors');
const { performance } = require('perf_hooks');

const express                  = require('express');
const ExpressWs                = require('express-ws');
const twilio                   = require('twilio');
const VoiceResponse            = require('twilio').twiml.VoiceResponse;

const { GptService }           = require('./services/gpt-service');
const { StreamService }        = require('./services/stream-service');
const { TranscriptionService } = require('./services/transcription-service');
const { TextToSpeechService }  = require('./services/tts-service');
const { RagService }           = require('./services/rag-service');

const app  = express();

/* keep verifyClient hack so .url retains query if Twilio ever adds one */
ExpressWs(app, null, {
  wsOptions: {
    verifyClient: (info) => {
      info.req.url = info.req.url.replace('/.websocket', '');
      return true;
    }
  }
});

const PORT = process.env.PORT || 6969;
app.use(express.urlencoded({ extended: false }));  // parse Twilio POST body

/* ── Twilio creds & escalation target ──────────────────────── */
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const ESCALATION_NUMBER = process.env.ESCALATION_NUMBER;

/* 1 ▪ Twilio webhook: <Connect><Stream> ---------------------- */
app.post('/incoming', (req, res) => {
  let callerNumber = req.body.From || '';
  if (!callerNumber.match(/^\+\d{10,15}$/)) {
    console.warn('Warning: Invalid or missing caller number from Twilio:', callerNumber);
    callerNumber = '';
  }
  console.log(`Incoming call from: ${callerNumber}`.bgCyan.black);

  const twiml    = new VoiceResponse();
  const connect  = twiml.connect();
  const streamEl = connect.stream({ url: `wss://${process.env.SERVER}/connection` });
  streamEl.parameter({ name: 'callerNumber', value: callerNumber });

  console.log('Generated WebSocket options:', { url: streamEl._uri, parameters: { callerNumber } });
  res.type('text/xml').end(twiml.toString());
});

/* 2 ▪ WebSocket per call ------------------------------------ */
app.ws('/connection', (ws, req) => {
  ws.on('error', console.error);

  console.log('Debug - Headers:', req.headers);

  /* per-call singletons */
  let streamSid, callSid, callerNumber = '';
  const gptService           = new GptService();
  const ragService           = new RagService();
  const streamService        = new StreamService(ws);
  const transcriptionService = new TranscriptionService();
  const ttsService           = new TextToSpeechService({});

  /* state */
  let marks            = [];
  let assistantTalking = false;
  let spokenSoFar      = '';
  let interactionCount = 0;
  let callEscalated    = false;

  /* ── Twilio → server messages ───────────────────────────── */
  ws.on('message', (data) => {
    const msg = JSON.parse(data);

    switch (msg.event) {

      /* first frame ---------------------------------------------------------- */
      case 'start':
        streamSid     = msg.start.streamSid;
        callSid       = msg.start.callSid;
        callerNumber  = msg.start.customParameters?.callerNumber || 'Unknown';

        streamService.setStreamSid(streamSid);
        gptService.setCallSid(callSid);

        console.log(`WebSocket connection debug:
  - URL: ${req.url}
  - Extracted number: ${callerNumber}`);

        console.log(`Twilio ▶ stream ${streamSid} start`.underline.red);

        ttsService.generate(
          { partialResponseIndex: null, partialResponse: 'Welcome to the One Piece Store. Nami this side!' },
          0
        );
        break;

      /* audio ---------------------------------------------------------------- */
      case 'media':
        transcriptionService.send(msg.media.payload);
        break;

      /* mark ----------------------------------------------------------------- */
      case 'mark':
        marks = marks.filter(m => m !== msg.mark.name);
        if (marks.length === 0) assistantTalking = false;
        console.log(`Twilio ▶ Audio completed mark: ${msg.mark.name}`.red);
        break;

      /* stop ----------------------------------------------------------------- */
      case 'stop':
        console.log(`Twilio ▶ stream ${streamSid} end`.underline.red);
        break;
    }
  });

  /* ── interruption detector ──────────────────────────────── */
  transcriptionService.on('utterance', (text) => {
    if (assistantTalking && text?.trim().length && !callEscalated) {
      console.log('Twilio ▶ interruption → clear/stop'.red);

      gptService.addAssistantMessage(spokenSoFar);
      spokenSoFar = '';
      gptService.skipNextAssistantSave = true;

      marks = [];
      assistantTalking = false;
      streamService.resetAfterClear();

      // cancel all pending TTS chunks if class exposes it
      if (typeof ttsService.cancelAll === 'function') ttsService.cancelAll();

      ws.send(JSON.stringify({ streamSid, event: 'clear' }));
      // ws.send(JSON.stringify({ streamSid, event: 'stop' })); // optional
    }
  });

  /* ── STT → RAG → (maybe escalate) → GPT ─────────────────── */
  transcriptionService.on('transcription', async (text) => {
    if (!text || callEscalated) return;

    const turnStart = performance.now();
    console.log(`Interaction ${interactionCount} – STT: ${text}`.yellow);

    let context = '', isEscalation = false;
    try {
      const t0 = performance.now();
      const { context: ctx, isEscalation: flag } = await ragService.getContext(
        text,
        JSON.stringify(gptService.userContext),
        { caller_number: callerNumber, escalated_to: ESCALATION_NUMBER }
      );
      console.log(`[LATENCY] RAG: ${(performance.now() - t0).toFixed(0)} ms`.cyan);
      context      = ctx;
      isEscalation = flag;
    } catch (err) {
      console.error('RAG service failed; proceeding without context'.red, err);
    }

    /* escalate? ------------------------------------------------------------- */
    if (isEscalation) {
      callEscalated = true;
      console.log('✳ Escalation requested – forwarding call'.bgRed.white);

      try {
        await twilioClient.calls(callSid).update({
          twiml: `<Response><Dial>${ESCALATION_NUMBER}</Dial></Response>`
        });
        ws.close();                       // close current media stream
      } catch (err) {
        console.error('Failed to dial escalation number'.red, err);
      }
      return;
    }

    /* normal GPT flow ------------------------------------------------------- */
    const gptStart = performance.now();
    gptService.once('gptreply', () => {
      console.log(`[LATENCY] GPT first chunk: ${(performance.now() - gptStart).toFixed(0)} ms`.magenta);
    });

    gptService.completion(text, interactionCount, 'user', 'user', context);
    interactionCount += 1;

    ttsService.once('speech', () => {
      console.log(`[LATENCY] Turn-around: ${(performance.now() - turnStart).toFixed(0)} ms`.yellow);
    });
  });

  /* ── GPT chunk → TTS ───────────────────────────────────── */
  gptService.on('gptreply', (chunk, icount) => {
    if (callEscalated) return;
    spokenSoFar += chunk.partialResponse;
    ttsService.generate(chunk, icount);
  });

  /* ── TTS audio → Twilio (ordered) ──────────────────────── */
  ttsService.on('speech', (idx, audio, label) => {
    if (callEscalated) return;
    streamService.buffer(idx, audio);
  });

  /* ── mark bookkeeping ──────────────────────────────────── */
  streamService.on('audiosent', (label) => {
    marks.push(label);
    assistantTalking = true;
  });
});

/* ──────────────────────────────────────────────────────────── */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
