// services/gpt-service.js
// -----------------------------------------------------------------------------
// GPT orchestration layer (streaming) with RAG context injection + interruption
// handling.  Drop this file into `services/` and require it from app.js.
//
// Exposed methods
//   • setCallSid(callSid)               – add Twilio call-sid to context
//   • completion(text, iCnt, role, name, extraCtx)
//   • addAssistantMessage(text)         – persist spoken portion on interrupt
//
// Extra parameter `extraCtx` (string) is injected as a hidden system message
// so RAG retrieval can inform the model without being revealed to the caller.
// -----------------------------------------------------------------------------

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
console.log(
  'Loaded OpenAI Key:',
  process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.slice(0, 30) + '...' : 'NOT FOUND'
);
require('colors');
const EventEmitter = require('events');
const OpenAI       = require('openai');

// ── sanity check ───────────────────────────────────────────────
if (!process.env.OPENAI_API_KEY) {
  console.error('OpenAI API key is not set in environment variables'.red);
  throw new Error('OpenAI API key is required');
}

class GptService extends EventEmitter {
  constructor() {
    super();
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    /* running chat memory */
    this.userContext = [
      {
        role: 'system',
        content: `You are Nami, the friendly One Piece Store assistant.  
        Keep all replies concise, upbeat, and on-theme. 
        Gurdrail: Your scope is limited to store policies and the Onepiece Series discussions.
        When offering “[You might ask about …]” suggestions, only propose questions you can answer directly from our policies and FAQ (categories in policies : products, orders, shipping, returns, payment methods, return windows, non-returnable items, damaged/incorrect goods, order status & tracking, address changes, international duties, refund timing, gift cards, privacy practices, terms & cancellations, dispute resolution, customer service channels & hours).  
      
        If you genuinely don’t know the answer (and it’s about store services or One Piece), offer: “I’m not sure about this myself, would you like to speak to a human agent?”  
        Insert a “•” symbol every 5–10 words at natural pauses so our TTS can split audio cleanly.`,
      },
      {
        role: 'assistant',
        content: "Welcome to the One Piece Store. • Nami this side?",
      },
    ];


    /* per-turn tracking */
    this.partialResponseIndex  = 0;
    this._assistantSoFar       = '';
    this.skipNextAssistantSave = false;
  }

  /* persist portion already played if caller interrupts */
  addAssistantMessage(text) {
    if (text?.trim().length) {
      this.userContext.push({ role: 'assistant', content: text.trim() });
      console.log('GPT -> saved spoken portion to context'.green);
    }
  }

  /* traceability */
  setCallSid(callSid) {
    this.userContext.push({ role: 'system', content: `callSid: ${callSid}` });
  }

  /* helper to push any message */
  updateUserContext(name, role, text) {
    if (name !== 'user') {
      this.userContext.push({ role, name, content: text });
    } else {
      this.userContext.push({ role, content: text });
    }
  }

  /* main streaming completion
     extraContext: retrieved RAG chunks (string)                         */
  async completion(
    text,
    interactionCount,
    role = 'user',
    name = 'user',
    extraContext = ''
  ) {
    try {
      /* 1. add caller utterance */
      this.updateUserContext(name, role, text);

      /* 2. inject RAG context (if any) */
      if (extraContext?.trim().length) {
        this.updateUserContext(
          'retrieval',
          'system',
          `Additional factual context (do not reveal to caller):\n${extraContext}`
        );
      }

      /* 3. request streamed completion */
      const stream = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini-2024-07-18',
        messages: this.userContext,
        stream: true,
      });

      /* 4. handle stream */
      let completeResponse = '';
      let partialResponse  = '';

      for await (const chunk of stream) {
        const content       = chunk.choices[0]?.delta?.content || '';
        const finishReason  = chunk.choices[0].finish_reason;

        completeResponse   += content;
        partialResponse    += content;
        this._assistantSoFar += content;

        /* send to TTS on '•' or stream end */
        if (content.trim().slice(-1) === '•' || finishReason === 'stop') {
          this.emit('gptreply',
            { partialResponseIndex: this.partialResponseIndex, partialResponse },
            interactionCount
          );
          this.partialResponseIndex += 1;
          partialResponse = '';
        }
      }

      /* 5. decide whether to store assistant reply */
      if (this.skipNextAssistantSave) {
        this.skipNextAssistantSave = false;
        this._assistantSoFar = '';
        console.log('GPT reply discarded due to interruption'.yellow);
      } else {
        this.userContext.push({ role: 'assistant', content: completeResponse });
        this._assistantSoFar = '';
        console.log(`GPT -> user context length: ${this.userContext.length}`.green);
      }

    } catch (error) {
      console.error('Error in GPT completion:'.red, error);

      const fallback =
        error.code === 'rate_limit_exceeded'
          ? "I apologize, but I'm temporarily unavailable. Please try again shortly. •"
          : 'I apologize, but I encountered an error. Please try again. •';

      this.emit(
        'gptreply',
        { partialResponseIndex: this.partialResponseIndex, partialResponse: fallback },
        interactionCount
      );
    }
  }
}

module.exports = { GptService };
