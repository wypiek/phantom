// Bit-depth + sample-rate reduction for PHANTOM's "digital interference".
class BitcrusherProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 16, minValue: 1, maxValue: 16 },
      { name: 'hold', defaultValue: 1, minValue: 1, maxValue: 32 },
    ];
  }
  constructor() {
    super();
    this.counter = 0;
    this.held = [0, 0];
  }
  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const bits = params.bits[0];
    const hold = Math.max(1, Math.round(params.hold[0]));
    const step = Math.pow(0.5, bits - 1);
    for (let ch = 0; ch < output.length; ch++) {
      const inp = input[ch] || input[0];
      const out = output[ch];
      let counter = this.counter;
      let held = this.held[ch] || 0;
      for (let i = 0; i < out.length; i++) {
        if (counter % hold === 0) held = bits >= 16 ? inp[i] : step * Math.floor(inp[i] / step + 0.5);
        out[i] = held;
        counter++;
      }
      this.held[ch] = held;
      if (ch === output.length - 1) this.counter = counter % 3600;
    }
    return true;
  }
}
registerProcessor('phantom-bitcrusher', BitcrusherProcessor);
