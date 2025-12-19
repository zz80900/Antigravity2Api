/**
 * ClaudeTransformer - Claude 格式请求/响应转换器
 * 
 * 基于 ThoughtSignatures Gemini API 官方文档实现
 * 支持 thinking、签名、函数调用等场景
 */

// ==================== 签名管理器 ====================
class SignatureManager {
  constructor() {
    this.pending = null;
  }
  
  // 存储签名
  store(signature) {
    if (signature) this.pending = signature;
  }
  
  // 消费并返回签名
  consume() {
    const sig = this.pending;
    this.pending = null;
    return sig;
  }
  
  // 是否有暂存的签名
  hasPending() {
    return !!this.pending;
  }
}

// ==================== 流式状态机 ====================
class StreamingState {
  // 块类型常量
  static BLOCK_NONE = 0;
  static BLOCK_TEXT = 1;
  static BLOCK_THINKING = 2;
  static BLOCK_FUNCTION = 3;
  
  constructor(encoder, controller) {
    this.encoder = encoder;
    this.controller = controller;
    this.blockType = StreamingState.BLOCK_NONE;
    this.blockIndex = 0;
    this.messageStartSent = false;
    this.messageStopSent = false;
    this.usedTool = false;
    this.signatures = new SignatureManager();  // thinking/FC 签名
    this.trailingSignature = null;  // 空 text 带签名（必须单独用空 thinking 块承载）
  }
  
  // 发送 SSE 事件
  emit(eventType, data) {
    this.controller.enqueue(
      this.encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
    );
  }
  
  // 发送 message_start 事件
  emitMessageStart(rawJSON) {
    if (this.messageStartSent) return;
    
    const usage = rawJSON.usageMetadata ? toClaudeUsage(rawJSON.usageMetadata) : undefined;
    
    this.emit("message_start", {
      type: "message_start",
      message: {
        id: rawJSON.responseId || "msg_" + Math.random().toString(36).substring(2),
        type: "message",
        role: "assistant",
        content: [],
        model: rawJSON.modelVersion,
        stop_reason: null,
        stop_sequence: null,
        ...(usage ? { usage } : {})
      }
    });
    this.messageStartSent = true;
  }
  
  // 开始新的内容块
  startBlock(type, contentBlock) {
    if (this.blockType !== StreamingState.BLOCK_NONE) {
      this.endBlock();
    }
    
    this.emit("content_block_start", {
      type: "content_block_start",
      index: this.blockIndex,
      content_block: contentBlock
    });
    this.blockType = type;
  }
  
  // 结束当前内容块
  endBlock() {
    if (this.blockType === StreamingState.BLOCK_NONE) return;
    
    // 如果是 thinking 块结束，先发送暂存的签名（来自 thinking part）
    if (this.blockType === StreamingState.BLOCK_THINKING && this.signatures.hasPending()) {
      this.emitDelta("signature_delta", { signature: this.signatures.consume() });
    }
    
    this.emit("content_block_stop", {
      type: "content_block_stop",
      index: this.blockIndex
    });
    this.blockIndex++;
    this.blockType = StreamingState.BLOCK_NONE;
  }
  
  // 发送 delta 事件
  emitDelta(deltaType, deltaContent) {
    this.emit("content_block_delta", {
      type: "content_block_delta",
      index: this.blockIndex,
      delta: { type: deltaType, ...deltaContent }
    });
  }
  
  // 发送结束事件
  emitFinish(finishReason, usageMetadata) {
    // 关闭最后一个块
    this.endBlock();
    
    // 根据官方文档（PDF 776-778 行）：签名可能在空文本 part 上返回
    // trailingSignature 是来自空 text part 的签名，必须用独立的空 thinking 块承载
    // 不能附加到之前的 thinking 块（签名必须在收到它的 part 位置返回）
    if (this.trailingSignature) {
      this.emit("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "thinking", thinking: "" }
      });
      this.emitDelta("thinking_delta", { thinking: "" });
      this.emitDelta("signature_delta", { signature: this.trailingSignature });
      this.emit("content_block_stop", {
        type: "content_block_stop",
        index: this.blockIndex
      });
      this.blockIndex++;
      this.trailingSignature = null;
    }
    
    // 确定 stop_reason
    let stopReason = "end_turn";
    if (this.usedTool) {
      stopReason = "tool_use";
    } else if (finishReason === "MAX_TOKENS") {
      stopReason = "max_tokens";
    }
    
    const usage = toClaudeUsage(usageMetadata || {});
    
    this.emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage
    });
    
    if (!this.messageStopSent) {
      this.controller.enqueue(
        this.encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n')
      );
      this.messageStopSent = true;
    }
  }
}

// ==================== Part 处理器 ====================
class PartProcessor {
  constructor(state) {
    this.state = state;
  }
  
  // 处理单个 part
  process(part) {
    const signature = part.thoughtSignature;
    
    // 函数调用处理
    // 根据官方文档（PDF 44行）：签名必须原样返回到收到签名的那个 part
    // - Gemini 3 Pro：签名在第一个 FC（PDF 784行）
    // - Gemini 2.5：签名在第一个 part，不论类型（PDF 785行）
    // 所以 FC 只使用自己的签名，不消费 thinking 的签名
    if (part.functionCall) {
      // 修复场景 B4/C3：空 text 带签名后跟 FC
      // 必须先输出空 thinking 块承载 trailingSignature，再处理 FC
      if (this.state.trailingSignature) {
        this.state.endBlock();  // 关闭当前块
        this.state.emit("content_block_start", {
          type: "content_block_start",
          index: this.state.blockIndex,
          content_block: { type: "thinking", thinking: "" }
        });
        this.state.emitDelta("thinking_delta", { thinking: "" });
        this.state.emitDelta("signature_delta", { signature: this.state.trailingSignature });
        this.state.emit("content_block_stop", {
          type: "content_block_stop",
          index: this.state.blockIndex
        });
        this.state.blockIndex++;
        this.state.trailingSignature = null;
      }
      this.processFunctionCall(part.functionCall, signature);
      return;
    }
    
    // 空 text 带签名：暂存到 trailingSignature，不能混入 thinking 的签名
    if (part.text !== undefined && !part.thought && part.text.length === 0) {
      if (signature) {
        this.state.trailingSignature = signature;
      }
      return;
    }
    
    if (part.text !== undefined) {
      if (part.thought) {
        // thinking 场景
        
        // 修复：如果有 trailingSignature（来自之前的空 text），先输出空 thinking 块
        // 根据规范（PDF 44行）：签名必须在收到它的 part 位置返回
        if (this.state.trailingSignature) {
          this.state.endBlock();
          this.state.emit("content_block_start", {
            type: "content_block_start",
            index: this.state.blockIndex,
            content_block: { type: "thinking", thinking: "" }
          });
          this.state.emitDelta("thinking_delta", { thinking: "" });
          this.state.emitDelta("signature_delta", { signature: this.state.trailingSignature });
          this.state.emit("content_block_stop", {
            type: "content_block_stop",
            index: this.state.blockIndex
          });
          this.state.blockIndex++;
          this.state.trailingSignature = null;
        }
        
        this.processThinking(part.text);
        // 签名暂存，在 thinking 块结束时发送
        if (signature) {
          this.state.signatures.store(signature);
        }
      } else {
        // 非 thinking text 场景
        
        // 修复：如果有 trailingSignature（来自之前的空 text），先输出空 thinking 块
        // 根据规范（PDF 44行）：签名必须在收到它的 part 位置返回
        if (this.state.trailingSignature) {
          this.state.endBlock();
          this.state.emit("content_block_start", {
            type: "content_block_start",
            index: this.state.blockIndex,
            content_block: { type: "thinking", thinking: "" }
          });
          this.state.emitDelta("thinking_delta", { thinking: "" });
          this.state.emitDelta("signature_delta", { signature: this.state.trailingSignature });
          this.state.emit("content_block_stop", {
            type: "content_block_stop",
            index: this.state.blockIndex
          });
          this.state.blockIndex++;
          this.state.trailingSignature = null;
        }
        
        if (signature) {
          // 根据规范（PDF 行44）：非空 text 带签名必须立即处理，不能合并到当前 text 块
          // 1. 先关闭当前块
          this.state.endBlock();
          // 2. 开始新 text 块并发送内容
          this.state.startBlock(StreamingState.BLOCK_TEXT, { type: "text", text: "" });
          this.state.emitDelta("text_delta", { text: part.text });
          // 3. 关闭 text 块
          this.state.endBlock();
          // 4. 创建空 thinking 块承载签名（Claude 格式限制：text 不支持 signature）
          this.state.emit("content_block_start", {
            type: "content_block_start",
            index: this.state.blockIndex,
            content_block: { type: "thinking", thinking: "" }
          });
          this.state.emitDelta("thinking_delta", { thinking: "" });
          this.state.emitDelta("signature_delta", { signature });
          this.state.emit("content_block_stop", {
            type: "content_block_stop",
            index: this.state.blockIndex
          });
          this.state.blockIndex++;
        } else {
          this.processText(part.text);
        }
      }
      return;
    }
  }
  
  // 处理 thinking 内容（签名由调用方在 process() 中处理）
  processThinking(text) {
    if (this.state.blockType === StreamingState.BLOCK_THINKING) {
      // 继续 thinking
      this.state.emitDelta("thinking_delta", { thinking: text });
    } else {
      // 开始新的 thinking 块
      this.state.startBlock(StreamingState.BLOCK_THINKING, { type: "thinking", thinking: "" });
      this.state.emitDelta("thinking_delta", { thinking: text });
    }
  }
  
  // 处理普通文本
  processText(text) {
    if (!text) return;
    
    if (this.state.blockType === StreamingState.BLOCK_TEXT) {
      // 继续 text
      this.state.emitDelta("text_delta", { text });
    } else {
      // 开始新的 text 块
      this.state.startBlock(StreamingState.BLOCK_TEXT, { type: "text", text: "" });
      this.state.emitDelta("text_delta", { text });
    }
  }
  
  // 处理函数调用
  processFunctionCall(fc, sigToUse) {
    // 签名已在 process() 中处理：FC 自带签名优先，否则使用 thinking 暂存的签名
    const toolId = fc.id || `${fc.name}-${Math.random().toString(36).substring(2, 10)}`;
    
    const toolUseBlock = {
      type: "tool_use",
      id: toolId,
      name: fc.name,
      input: {}
    };
    
    // 根据官方文档：签名附加到 tool_use 块
    if (sigToUse) {
      toolUseBlock.signature = sigToUse;
    }
    
    this.state.startBlock(StreamingState.BLOCK_FUNCTION, toolUseBlock);
    
    if (fc.args) {
      this.state.emitDelta("input_json_delta", { partial_json: JSON.stringify(fc.args) });
    }
    
    this.state.usedTool = true;
  }
}

// ==================== 非流式处理器 ====================
class NonStreamingProcessor {
  constructor(rawJSON) {
    this.raw = rawJSON;
    this.contentBlocks = [];
    this.textBuilder = "";
    this.thinkingBuilder = "";
    this.hasToolCall = false;
    // 分离两种签名来源：
    // thinkingSignature: 来自 thought=true 的 part，随 thinking 块输出
    // trailingSignature: 来自空普通文本的 part，在 process() 末尾用空 thinking 块承载
    this.thinkingSignature = null;
    this.trailingSignature = null;
  }
  
  process() {
    const parts = this.raw.candidates?.[0]?.content?.parts || [];
    
    for (const part of parts) {
      this.processPart(part);
    }
    
    // 刷新剩余内容（按原始顺序）
    this.flushThinking();
    this.flushText();
    
    // 处理空普通文本带签名的场景（PDF 776-778）
    // 签名在最后一个 part，但那是空文本，需要输出空 thinking 块承载签名
    if (this.trailingSignature) {
      this.contentBlocks.push({
        type: "thinking",
        thinking: "",
        signature: this.trailingSignature
      });
      this.trailingSignature = null;
    }
    
    return this.buildResponse();
  }
  
  processPart(part) {
    const signature = part.thoughtSignature;
    
    // FC 处理：先刷新之前的内容，再处理 FC（防止 FC 签名污染 thinking 块）
    if (part.functionCall) {
      // 根据官方文档（PDF 44行）：签名必须原样返回到收到签名的那个 part
      // thinking 的签名留在 thinking 块，FC 的签名留在 FC 块
      this.flushThinking();
      this.flushText();
      
      // 修复场景 B4/C3：空 text 带签名后跟 FC（Gemini 2.5 风格）
      // 必须先输出空 thinking 块承载 trailingSignature，再处理 FC
      if (this.trailingSignature) {
        this.contentBlocks.push({
          type: "thinking",
          thinking: "",
          signature: this.trailingSignature
        });
        this.trailingSignature = null;
      }
      
      this.hasToolCall = true;
      
      // 优先复用上游的 functionCall.id
      const toolId = part.functionCall.id || `${part.functionCall.name}-${Math.random().toString(36).substring(2, 10)}`;
      
      const toolUseBlock = {
        type: "tool_use",
        id: toolId,
        name: part.functionCall.name,
        input: part.functionCall.args || {}
      };
      
      // 只使用 FC 自己的签名
      if (signature) {
        toolUseBlock.signature = signature;
      }
      
      this.contentBlocks.push(toolUseBlock);
      return;
    }
    
    // 使用 !== undefined 判断，确保空字符串 thinking 也能正确处理签名
    if (part.text !== undefined) {
      if (part.thought) {
        this.flushText();
        
        // 修复：如果有 trailingSignature（来自之前的空 text），先输出空 thinking 块
        // 根据规范（PDF 44行）：签名必须在收到它的 part 位置返回
        if (this.trailingSignature) {
          this.flushThinking();  // 先刷新之前累积的 thinking
          this.contentBlocks.push({
            type: "thinking",
            thinking: "",
            signature: this.trailingSignature
          });
          this.trailingSignature = null;
        }
        
        this.thinkingBuilder += part.text;
        // thinking 的签名暂存到 thinkingSignature，在 flushThinking 时消费
        if (signature) {
          this.thinkingSignature = signature;
        }
      } else {
        // 根据官方规范（PDF 行44）：签名必须在收到它的 part 位置返回
        // 非空 text 带签名时，先刷新当前 text，再输出空 thinking 块承载签名
        // 空 text 带签名时，暂存到 trailingSignature，在 process() 末尾消费
        if (part.text.length === 0) {
          // 空普通文本的签名暂存
          if (signature) {
            this.trailingSignature = signature;
          }
          return;
        }
        
        this.flushThinking();
        
        // 修复：如果有 trailingSignature（来自之前的空 text），先输出空 thinking 块
        // 根据规范（PDF 44行）：签名必须在收到它的 part 位置返回
        if (this.trailingSignature) {
          this.flushText();  // 先刷新之前累积的 text
          this.contentBlocks.push({
            type: "thinking",
            thinking: "",
            signature: this.trailingSignature
          });
          this.trailingSignature = null;
        }
        
        this.textBuilder += part.text;
        
        // 非空 text 带签名时，立即刷新 text 并输出空 thinking 块承载签名
        if (signature) {
          this.flushText();
          this.contentBlocks.push({
            type: "thinking",
            thinking: "",
            signature: signature
          });
        }
      }
    }
  }
  
  flushText() {
    if (this.textBuilder.length === 0) return;
    this.contentBlocks.push({
      type: "text",
      text: this.textBuilder
    });
    this.textBuilder = "";
  }
  
  flushThinking() {
    // 如果没有 thinking 内容且没有 thinking 签名，直接返回
    // 有 thinkingSignature 时必须输出（即使 thinking 为空），保证签名在正确位置
    if (this.thinkingBuilder.length === 0 && !this.thinkingSignature) return;
    
    const block = {
      type: "thinking",
      thinking: this.thinkingBuilder || ""
    };
    
    // 如果有 thinking 签名，附加到 thinking 块
    if (this.thinkingSignature) {
      block.signature = this.thinkingSignature;
      this.thinkingSignature = null;
    }
    
    this.contentBlocks.push(block);
    this.thinkingBuilder = "";
  }
  
  buildResponse() {
    const finish = this.raw.candidates?.[0]?.finishReason;
    let stopReason = "end_turn";
    
    if (this.hasToolCall) {
      stopReason = "tool_use";
    } else if (finish === "MAX_TOKENS") {
      stopReason = "max_tokens";
    }
    
    const response = {
      id: this.raw.responseId || "",
      type: "message",
      role: "assistant",
      model: this.raw.modelVersion || "",
      content: this.contentBlocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: toClaudeUsage(this.raw.usageMetadata)
    };
    
    // 如果没有 usage 数据，删除该字段
    if (response.usage.input_tokens === 0 && response.usage.output_tokens === 0) {
      if (!this.raw.usageMetadata) {
        delete response.usage;
      }
    }
    
    return response;
  }
}

// ==================== 工具函数 ====================

// 提取 thoughtSignature
function extractThoughtSignature(parts = []) {
  const match = (parts || []).find((part) => part?.thoughtSignature);
  return match?.thoughtSignature ?? undefined;
}

// 转换 usageMetadata 为 Claude 格式
function toClaudeUsage(usageMetadata = {}) {
  const prompt = usageMetadata.promptTokenCount || 0;
  const candidates = usageMetadata.candidatesTokenCount || 0;
  const thoughts = usageMetadata.thoughtsTokenCount || 0;
  
  if (usageMetadata.totalTokenCount && usageMetadata.totalTokenCount >= prompt) {
    return {
      input_tokens: prompt,
      output_tokens: usageMetadata.totalTokenCount - prompt
    };
  }
  
  return {
    input_tokens: prompt,
    output_tokens: candidates + thoughts
  };
}

// ==================== 请求转换相关 ====================

/**
 * 清理 JSON Schema 以符合 Gemini 格式
 */
function cleanJsonSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(cleanJsonSchema);

  const validationFields = {
    minLength: "minLength",
    maxLength: "maxLength",
    minimum: "minimum",
    maximum: "maximum",
    minItems: "minItems",
    maxItems: "maxItems",
  };
  const fieldsToRemove = ["$schema", "additionalProperties"];

  const validations = [];
  for (const [field, label] of Object.entries(validationFields)) {
    if (field in schema) {
      validations.push(`${label}: ${schema[field]}`);
    }
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(schema)) {
    if (fieldsToRemove.includes(key) || key in validationFields) continue;
    if (key === "format") continue;
    if (key === "default") continue;
    if (key === "uniqueItems") continue;

    // Normalize union types like ["string","null"] to a single type (prefer non-null)
    if (key === "type" && Array.isArray(value)) {
      const filtered = value.filter(v => v !== "null");
      cleaned.type = filtered[0] || value[0] || "string";
      continue;
    }

    if (key === "description" && validations.length > 0) {
      cleaned[key] = `${value} (${validations.join(", ")})`;
    } else if (typeof value === "object" && value !== null) {
      cleaned[key] = cleanJsonSchema(value);
    } else {
      cleaned[key] = value;
    }
  }

  if (validations.length > 0 && !cleaned.description) {
    cleaned.description = `Validation: ${validations.join(", ")}`;
  }

  return uppercaseSchemaTypes(cleaned);
}

/**
 * 将 schema 类型转换为大写
 */
function uppercaseSchemaTypes(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(uppercaseSchemaTypes);

  const normalized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type") {
      if (typeof value === "string") {
        normalized[key] = value.toUpperCase();
      } else if (Array.isArray(value)) {
        normalized[key] = value.map((item) =>
          typeof item === "string" ? item.toUpperCase() : item
        );
      } else {
        normalized[key] = value;
      }
      continue;
    }
    normalized[key] =
      typeof value === "object" && value !== null
        ? uppercaseSchemaTypes(value)
        : value;
  }
  return normalized;
}

/**
 * Claude 模型名映射到 Gemini 模型名
 */
function mapClaudeModelToGemini(claudeModel) {
  const supportedModels = [
    "claude-opus-4-5-thinking",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-thinking",
  ];
  if (supportedModels.includes(claudeModel)) return claudeModel;

  const mapping = {
    "claude-sonnet-4-5-20250929": "claude-sonnet-4-5-thinking",
    "claude-3-5-sonnet-20241022": "claude-sonnet-4-5",
    "claude-3-5-sonnet-20240620": "claude-sonnet-4-5",
    "claude-opus-4": "claude-opus-4-5-thinking",
    "claude-opus-4-5-20251101": "claude-opus-4-5-thinking",
    "claude-opus-4-5": "claude-opus-4-5-thinking",
    "claude-haiku-4": "claude-sonnet-4-5",
    "claude-3-haiku-20240307": "claude-sonnet-4-5",
    "claude-haiku-4-5-20251001": "claude-sonnet-4-5",
    "gemini-2.5-flash": "gemini-2.5-flash"
  };
  return mapping[claudeModel] || "claude-sonnet-4-5";
}

/**
 * 转换 Claude 请求为 v1internal 请求 body（不包含 URL/Authorization）。
 * @param {Object} claudeReq - Claude 格式的请求
 * @param {string} projectId - 项目 ID
 * @returns {{ body: object }} 包含 v1internal body 的对象
 */
function transformClaudeRequestIn(claudeReq, projectId) {
  // 需要 crypto 模块生成 requestId
  const crypto = require("crypto");
  
  const hasWebSearchTool =
    Array.isArray(claudeReq.tools) &&
    claudeReq.tools.some((tool) => tool?.name === "web_search");

  // 记录 tool_use id 到 name 的映射，便于后续 tool_result 还原函数名
  const toolIdToName = new Map();

  // 1. System Instruction
  let systemInstruction = undefined;
  if (claudeReq.system) {
    const systemParts = [];
    if (Array.isArray(claudeReq.system)) {
      for (const item of claudeReq.system) {
        if (item && item.type === "text") {
          systemParts.push({ text: item.text || "" });
        }
      }
    } else if (typeof claudeReq.system === "string") {
      systemParts.push({ text: claudeReq.system });
    }

    if (systemParts.length > 0) {
      systemInstruction = {
        role: "user",
        parts: systemParts,
      };
    }
  }

  // 2. Contents (Messages)
  const contents = [];
  if (claudeReq.messages) {
    for (const msg of claudeReq.messages) {
      let role = msg.role;
      if (role === "assistant") {
        role = "model";
      }

      const clientContent = { role, parts: [] };
      
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === "text") {
            const text = item.text || "";
            if (text !== "(no content)") {
              clientContent.parts.push({ text: text });
            }
          } else if (item.type === "thinking") {
            // 根据官方文档：签名必须在收到签名的那个 part 上原样返回
            const part = {
              text: item.thinking || "",
              thought: true,
            };
            // 如果 thinking 有 signature，直接附加到当前 part
            if (item.signature) {
              part.thoughtSignature = item.signature;
            }
            clientContent.parts.push(part);
          } else if (item.type === "redacted_thinking") {
            const part = {
              text: item.data || "",
              thought: true,
            };
            clientContent.parts.push(part);
          } else if (item.type === "image") {
            // Handle image
            const source = item.source || {};
            if (source.type === "base64") {
              clientContent.parts.push({
                inlineData: {
                  mimeType: source.media_type || "image/png",
                  data: source.data || "",
                },
              });
            }
          } else if (item.type === "tool_use") {
            // 根据官方文档：签名必须在收到签名的那个 functionCall part 上原样返回
            const fcPart = {
              functionCall: {
                name: item.name,
                args: item.input || {},
                id: item.id,
              },
            };
            if (item.id && item.name) {
              toolIdToName.set(item.id, item.name);
            }
            // 如果 tool_use 有 signature，直接附加到当前 functionCall part
            if (item.signature) {
              fcPart.thoughtSignature = item.signature;
            }
            clientContent.parts.push(fcPart);
          } else if (item.type === "tool_result") {
            // 优先用先前记录的 tool_use id -> name 映射，还原原始函数名
            let funcName = toolIdToName.get(item.tool_use_id) || item.tool_use_id;
            
            let content = item.content || "";
            if (Array.isArray(content)) {
              content = content.map(c => c.text || JSON.stringify(c)).join("\n");
            }

            clientContent.parts.push({
              functionResponse: {
                name: funcName,
                response: { result: content },
                id: item.tool_use_id,
              },
            });
          }
        }
      } else if (typeof msg.content === "string") {
        clientContent.parts.push({ text: msg.content });
      }
      
      contents.push(clientContent);
    }
  }

  // 3. Tools
  let tools = undefined;
  if (claudeReq.tools && Array.isArray(claudeReq.tools)) {
    if (hasWebSearchTool) {
      // 映射 web_search 到 googleSearch 工具，带增强配置
      tools = [
        {
          googleSearch: {
            enhancedContent: {
              imageSearch: {
                maxResultCount: 5,
              },
            },
          },
        },
      ];
    } else {
      tools = [{ functionDeclarations: [] }];
      for (const tool of claudeReq.tools) {
        if (tool.input_schema) {
          const toolDecl = {
            name: tool.name,
            description: tool.description,
            parameters: uppercaseSchemaTypes(cleanJsonSchema(tool.input_schema)),
          };
          tools[0].functionDeclarations.push(toolDecl);
        }
      }
    }
  }

  // 4. Generation Config & Thinking
  const generationConfig = {};
  
  // Thinking - 只要启用 thinking 就必须设置 includeThoughts: true
  if (claudeReq.thinking && claudeReq.thinking.type === "enabled") {
    generationConfig.thinkingConfig = {
      includeThoughts: true
    };
    // 如果提供了 budget_tokens，则设置 thinkingBudget
    if (claudeReq.thinking.budget_tokens) {
      let budget = claudeReq.thinking.budget_tokens;
      // 使用 gemini-2.5-flash 时官方上限 24576，其余模型不强制改动
      const isFlashModel =
        hasWebSearchTool || (claudeReq.model && claudeReq.model.includes("gemini-2.5-flash"));
      if (isFlashModel) {
        budget = Math.min(budget, 24576);
      }
      generationConfig.thinkingConfig.thinkingBudget = budget;
    }
  }

  if (claudeReq.temperature !== undefined) {
    generationConfig.temperature = claudeReq.temperature;
  }
  if (claudeReq.top_p !== undefined) {
    generationConfig.topP = claudeReq.top_p;
  }
  if (claudeReq.top_k !== undefined) {
    generationConfig.topK = claudeReq.top_k;
  }

  // web_search 场景强制 candidateCount=1
  if (hasWebSearchTool) {
    generationConfig.candidateCount = 1;
  }

  // max_tokens 映射到 maxOutputTokens，且不超过 64000
  // if (claudeReq.max_tokens !== undefined) {
  //   generationConfig.maxOutputTokens = Math.min(claudeReq.max_tokens, 64000);
  // }
  generationConfig.maxOutputTokens = 64000;
  // Safety Settings
  const safetySettings = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" },
  ];

  // Build Request Body
  const innerRequest = {
    contents,
    tools:
      tools &&
      tools.length > 0 &&
      tools[0].functionDeclarations &&
      tools[0].functionDeclarations.length > 0
        ? tools
        : tools && tools.length > 0 && tools[0].googleSearch
        ? tools
        : undefined,
  };
  
  if (systemInstruction) {
    innerRequest.systemInstruction = systemInstruction;
  }
  
  // Add generationConfig if not empty
  if (Object.keys(generationConfig).length > 0) {
    innerRequest.generationConfig = generationConfig;
  }
  
  innerRequest.safetySettings = safetySettings;

  let geminiModel = mapClaudeModelToGemini(claudeReq.model);
  if (hasWebSearchTool) {
    geminiModel = "gemini-2.5-flash";
  }
  const requestId = `agent-${crypto.randomUUID()}`;
  const requestType = hasWebSearchTool ? "web_search" : "agent";

  const body = {
    project: projectId,
    requestId: requestId,
    request: innerRequest,
    model: geminiModel,
    userAgent: "antigravity",
    requestType,
  };

  // 如果调用方提供了 metadata.user_id，则复用为 sessionId
  if (claudeReq.metadata && claudeReq.metadata.user_id) {
    body.request.sessionId = claudeReq.metadata.user_id;
  }

  return {
    body: body,
  };
}

// ==================== 响应转换相关 ====================

/**
 * 转换 Claude 格式响应
 */
async function transformClaudeResponseOut(response) {
  const contentType = response.headers.get("Content-Type") || "";
  
  if (contentType.includes("application/json")) {
    return handleNonStreamingResponse(response);
  }
  
  if (contentType.includes("stream")) {
    return handleStreamingResponse(response);
  }
  
  return response;
}

// 处理非流式响应
async function handleNonStreamingResponse(response) {
  let json = await response.json();
  json = json.response || json;
  
  const processor = new NonStreamingProcessor(json);
  const result = processor.process();
  
  return new Response(JSON.stringify(result), {
    status: response.status,
    headers: { "Content-Type": "application/json" }
  });
}

// 处理流式响应
async function handleStreamingResponse(response) {
  if (!response.body) return response;
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      const state = new StreamingState(encoder, controller);
      const processor = new PartProcessor(state);
      
      try {
        let buffer = "";
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          
          for (const line of lines) {
            processSSELine(line, state, processor);
          }
        }
        
        // 处理剩余 buffer
        if (buffer) {
          processSSELine(buffer, state, processor);
        }
        
      } catch (error) {
        controller.error(error);
      } finally {
        controller.close();
      }
    }
  });
  
  return new Response(stream, {
    status: response.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });
}

// 处理单行 SSE 数据
function processSSELine(line, state, processor) {
  if (!line.startsWith("data: ")) return;
  
  const dataStr = line.slice(6).trim();
  if (!dataStr) return;
  
  if (dataStr === "[DONE]") {
    if (!state.messageStopSent) {
      state.controller.enqueue(
        state.encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n')
      );
      state.messageStopSent = true;
    }
    return;
  }
  
  try {
    let chunk = JSON.parse(dataStr);
    const rawJSON = chunk.response || chunk;
    
    // 发送 message_start
    state.emitMessageStart(rawJSON);
    
    // 处理所有 parts
    const parts = rawJSON.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      processor.process(part);
    }
    
    // 检查是否结束
    const finishReason = rawJSON.candidates?.[0]?.finishReason;
    if (finishReason) {
      state.emitFinish(finishReason, rawJSON.usageMetadata);
    }
    
  } catch (e) {
    // 解析失败，忽略
  }
}

// ==================== 导出 ====================
module.exports = {
  SignatureManager,
  StreamingState,
  PartProcessor,
  NonStreamingProcessor,
  transformClaudeRequestIn,
  transformClaudeResponseOut,
  extractThoughtSignature,
  toClaudeUsage,
  cleanJsonSchema,
  uppercaseSchemaTypes,
  mapClaudeModelToGemini
};
