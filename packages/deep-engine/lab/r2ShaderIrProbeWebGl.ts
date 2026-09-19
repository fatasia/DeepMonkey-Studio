import { hiZFirstStageTargetSize } from "../src/shaderCompute/index.js";
import type { R2BackendCaseResult, R2CaseRequest } from "./r2ShaderIrProbe.js";

/**
 * WebGL2 后端真机执行器（从 r2ShaderIrProbe 按职责拆出）：
 * 同一 GLSL 程序对（min/max 特化）+ uniform 诊断程序，R32F FBO 读写回。
 * 真机教训内建防御：FBO 附件纹理必须先从采样单元解绑，否则反馈环 → GL_INVALID_OPERATION。
 */

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

export function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`GLSL compile failed: ${gl.getShaderInfoLog(shader) ?? "no log"}`);
  }
  return shader;
}

/** uniform 诊断程序（非 IR 工件）：同组 uniform 直出像素，区分"uniform 没进 shader"与"逻辑误读"。 */
export const DIAGNOSTIC_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform uvec2 deep_u_sourceSize;
uniform uvec2 deep_u_targetSize;
uniform uint deep_u_reduceMax;
out vec4 diagOut;
void main() { diagOut = vec4(float(deep_u_reduceMax), float(deep_u_targetSize.y), float(deep_u_sourceSize.x), 0.0); }
`;

export function runWebGlCase(gl: WebGL2RenderingContext, programs: Readonly<Record<"min" | "max", WebGLProgram>>,
  diagnosticProgram: WebGLProgram, request: R2CaseRequest): R2BackendCaseResult {
  const program = programs[request.reduceMax ? "max" : "min"];
  const sw = request.sourceWidth, sh = request.sourceHeight;
  const [tw, th] = hiZFirstStageTargetSize(sw, sh);
  const input = new Float32Array(base64ToBytes(request.inputBase64).buffer.slice(0));
  const source = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, sw, sh, 0, gl.RED, gl.FLOAT, input);
  const target = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, tw, th, 0, gl.RED, gl.FLOAT, null);
  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("R32F framebuffer incomplete.");
  // target 曾占用 TEXTURE0：绘制前必须绑回 source，否则 FBO 附件与采样器成反馈环 → GL_INVALID_OPERATION。
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, source);
  gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.DITHER); gl.disable(gl.SCISSOR_TEST);
  gl.useProgram(program);
  gl.uniform2ui(gl.getUniformLocation(program, "deep_u_sourceSize"), sw, sh);
  gl.uniform2ui(gl.getUniformLocation(program, "deep_u_targetSize"), tw, th);
  gl.uniform1i(gl.getUniformLocation(program, "deepSource"), 0);
  gl.viewport(0, 0, tw, th);

  const repeats: string[] = [];
  let otherChannelMaxAbs = 0;
  let glError = 0;
  let diag = new Float32Array(4);
  try {
    for (let repeat = 0; repeat < 2; repeat++) {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // 分步 getError 定位（R32F 附件 + EXT_color_buffer_float 下 (RGBA, FLOAT) 为保证可读组合）。
      glError = gl.getError();
      if (glError !== gl.NO_ERROR) throw new Error(`gl.getError() = 0x${glError.toString(16)} after drawArrays.`);
      const packed = new Float32Array(tw * th * 4);
      gl.readPixels(0, 0, tw, th, gl.RGBA, gl.FLOAT, packed);
      glError = gl.getError();
      if (glError !== gl.NO_ERROR) {
        const readFormat = Number(gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT));
        const readType = Number(gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE));
        throw new Error(`gl.getError() = 0x${glError.toString(16)} after readPixels; implementation read format=0x${readFormat.toString(16)} type=0x${readType.toString(16)}.`);
      }
      const output = new Float32Array(tw * th);
      for (let texel = 0; texel < tw * th; texel++) {
        output[texel] = packed[texel * 4]!;
        otherChannelMaxAbs = Math.max(otherChannelMaxAbs, Math.abs(packed[texel * 4 + 1]!));
      }
      repeats.push(bytesToBase64(new Uint8Array(output.buffer)));
    }
  } finally {
    // 诊断：kernel 读完后再画诊断程序（覆盖 FBO 无妨），直出 shader 实际看到的 uniform。
    gl.useProgram(diagnosticProgram);
    gl.uniform1ui(gl.getUniformLocation(diagnosticProgram, "deep_u_reduceMax"), request.reduceMax ? 1 : 0);
    gl.uniform2ui(gl.getUniformLocation(diagnosticProgram, "deep_u_sourceSize"), sw, sh);
    gl.uniform2ui(gl.getUniformLocation(diagnosticProgram, "deep_u_targetSize"), tw, th);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    diag = new Float32Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, diag);
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer); gl.deleteTexture(source); gl.deleteTexture(target);
  }
  return { repeatsBase64: [repeats[0]!, repeats[1]!], validationMessages: [], glError, otherChannelMaxAbs,
    uniformShaderEcho: [diag[0]!, diag[1]!, diag[2]!] as const };
}
