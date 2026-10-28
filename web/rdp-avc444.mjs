// Full color (4:4:4) for the RDP pane's H.264. An AVC444 update arrives as two
// 4:2:0 pictures (MS-RDPEGFX 2.2.4.5): a main view with luma and subsampled
// chroma, and an auxiliary view packing the chroma samples the main view
// leaves out. This combines them on the GPU, with WebGL2, into a persistent
// 4:4:4 picture, and converts the picture to RGB with the transform
// MS-RDPEGFX specifies. The integer math matches IronRDP's CPU reference
// (`ironrdp-egfx` `avc444.rs`), so both give the same pixels.

// Layouts of the auxiliary view: AVC444 (3.3.8.3.2) and AVC444v2 (3.3.8.3.3).
export const avc444Layout = Object.freeze({ v1: 1, v2: 2 });

const vertexSource = `#version 300 es
void main() {
  // One triangle covering the viewport; scissor rectangles pick the pixels.
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

// Samples of a view: luma, and chroma from I420 planes or an NV12 plane.
const viewSource = `
uniform highp sampler2D uLuma;
uniform highp sampler2D uChromaU;
uniform highp sampler2D uChromaV;
uniform bool uInterleaved;
int luma(int x, int y) { return int(round(texelFetch(uLuma, ivec2(x, y), 0).r * 255.0)); }
int chromaU(int x, int y) {
  return int(round(texelFetch(uChromaU, ivec2(x, y), 0).r * 255.0));
}
int chromaV(int x, int y) {
  return uInterleaved
    ? int(round(texelFetch(uChromaU, ivec2(x, y), 0).g * 255.0))
    : int(round(texelFetch(uChromaV, ivec2(x, y), 0).r * 255.0));
}
vec4 sample444(int y, int u, int v) { return vec4(float(y), float(u), float(v), 255.0) / 255.0; }
`;

// The main view: luma, and each 2x2 block's chroma. Color masks pick which
// is written where.
const mainSource = `#version 300 es
precision highp float;
precision highp int;
${viewSource}
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = sample444(luma(p.x, p.y), chromaU(p.x / 2, p.y / 2), chromaV(p.x / 2, p.y / 2));
}`;

// The auxiliary view: every chroma sample but the even-row, even-column one,
// which keeps the main view's block average.
const auxiliarySource = `#version 300 es
precision highp float;
precision highp int;
${viewSource}
uniform int uLayout;
uniform int uHalfWidth;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x;
  int y = p.y;
  int u;
  int v;
  if (uLayout == 1) {
    if ((y & 1) == 1) {
      // B4 and B5: in each macroblock row, auxiliary luma rows 0 to 7 carry
      // the odd U rows and rows 8 to 15 the odd V rows.
      int row = y - y % 16 + (y % 16) / 2;
      u = luma(x, row);
      v = luma(x, row + 8);
    } else if ((x & 1) == 1) {
      // B6 and B7: odd columns of even rows.
      u = chromaU(x / 2, y / 2);
      v = chromaV(x / 2, y / 2);
    } else {
      discard;
    }
  } else {
    if ((x & 1) == 1) {
      // B4 and B5: odd columns, U on the left half of the luma row, V on the right.
      u = luma(x / 2, y);
      v = luma(uHalfWidth + x / 2, y);
    } else if ((y & 1) == 1) {
      // B6 to B9: even columns of odd rows, multiples of four from the U
      // plane and the others from the V plane, U on the left, V on the right.
      int quarter = uHalfWidth / 2;
      if (x % 4 == 0) {
        u = chromaU(x / 4, y / 2);
        v = chromaU(quarter + x / 4, y / 2);
      } else {
        u = chromaV(x / 4, y / 2);
        v = chromaV(quarter + x / 4, y / 2);
      }
    } else {
      discard;
    }
  }
  outColor = sample444(0, u, v);
}`;

// The combined picture to RGB: the reverse chroma filter (3.3.8.3.2), then
// the color transform (3.3.8.3.1). Rows are flipped for the canvas.
const convertSource = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uPicture;
uniform int uHeight;
out vec4 outColor;
ivec3 picture(ivec2 p) { return ivec3(round(texelFetch(uPicture, p, 0).rgb * 255.0)); }
int reverseFilter(int average, int right, int below, int diagonal) {
  int reversed = clamp(4 * average - right - below - diagonal, 0, 255);
  return abs(reversed - average) < 30 ? average : reversed;
}
void main() {
  ivec2 p = ivec2(int(gl_FragCoord.x), uHeight - 1 - int(gl_FragCoord.y));
  ivec3 s = picture(p);
  int u = s.y;
  int v = s.z;
  if (((p.x | p.y) & 1) == 0) {
    ivec3 right = picture(p + ivec2(1, 0));
    ivec3 below = picture(p + ivec2(0, 1));
    ivec3 diagonal = picture(p + ivec2(1, 1));
    u = reverseFilter(u, right.y, below.y, diagonal.y);
    v = reverseFilter(v, right.z, below.z, diagonal.z);
  }
  int luma = 256 * s.x;
  u -= 128;
  v -= 128;
  ivec3 rgb = clamp(ivec3(luma + 403 * v, luma - 48 * u - 120 * v, luma + 475 * u) >> 8, 0, 255);
  outColor = vec4(vec3(rgb) / 255.0, 1.0);
}`;

// Whether `planes` (see readVideoFramePlanes) is a picture the combiner takes.
function planeFormatSupported(format) {
  return format === "I420" || format === "NV12";
}

// Copies a decoded VideoFrame's planes out as they are, without color
// conversion. Resolves null for a format other than I420 or NV12. `buffer`
// is reused when it is large enough.
export async function readVideoFramePlanes(frame, buffer) {
  if (!planeFormatSupported(frame.format)) {
    return null;
  }
  const size = frame.allocationSize();
  const data = buffer && buffer.byteLength >= size ? buffer : new Uint8Array(size);
  const layout = await frame.copyTo(data);
  const width = frame.visibleRect?.width ?? frame.codedWidth;
  const height = frame.visibleRect?.height ?? frame.codedHeight;
  return { format: frame.format, width, height, data, layout };
}

// Creates the combiner, or returns null when WebGL2 isn't available.
// `createCanvas(width, height)` makes the canvas it renders to, which callers
// draw from with drawImage.
export function createRDPAVC444Combiner({ createCanvas = defaultCanvas } = {}) {
  const canvas = createCanvas(1, 1);
  const gl = canvas?.getContext?.("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) {
    return null;
  }
  let programs;
  try {
    programs = {
      main: program(gl, mainSource),
      auxiliary: program(gl, auxiliarySource),
      convert: program(gl, convertSource),
    };
  } catch {
    return null;
  }
  const viewTextures = { luma: texture(gl), chromaU: texture(gl), chromaV: texture(gl) };
  const pictureTexture = texture(gl);
  const framebuffer = gl.createFramebuffer();
  const vertexArray = gl.createVertexArray();
  let width = 0;
  let height = 0;

  // A new size starts a black picture, as IronRDP's does.
  function fit(viewWidth, viewHeight) {
    if (viewWidth === width && viewHeight === height) return;
    width = viewWidth;
    height = viewHeight;
    canvas.width = width;
    canvas.height = height;
    const black = new Uint8Array(width * height * 4);
    for (let i = 0; i < black.length; i += 4) {
      black[i + 1] = 128;
      black[i + 2] = 128;
      black[i + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, pictureTexture);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, black);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pictureTexture, 0);
  }

  function uploadPlane(target, format, internalFormat, planeWidth, planeHeight, data, layout, bytesPerSample) {
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layout.stride / bytesPerSample);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, planeWidth, planeHeight, 0, format, gl.UNSIGNED_BYTE, data, layout.offset);
  }

  function uploadView(planes) {
    const chromaWidth = Math.ceil(planes.width / 2);
    const chromaHeight = Math.ceil(planes.height / 2);
    const data = planes.data instanceof Uint8Array ? planes.data : new Uint8Array(planes.data);
    uploadPlane(viewTextures.luma, gl.RED, gl.R8, planes.width, planes.height, data, planes.layout[0], 1);
    if (planes.format === "NV12") {
      uploadPlane(viewTextures.chromaU, gl.RG, gl.RG8, chromaWidth, chromaHeight, data, planes.layout[1], 2);
    } else {
      uploadPlane(viewTextures.chromaU, gl.RED, gl.R8, chromaWidth, chromaHeight, data, planes.layout[1], 1);
      uploadPlane(viewTextures.chromaV, gl.RED, gl.R8, chromaWidth, chromaHeight, data, planes.layout[2], 1);
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  }

  function useViewProgram(source, planes) {
    gl.useProgram(source);
    const units = [viewTextures.luma, viewTextures.chromaU, viewTextures.chromaV];
    ["uLuma", "uChromaU", "uChromaV"].forEach((name, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, units[unit]);
      gl.uniform1i(gl.getUniformLocation(source, name), unit);
    });
    gl.uniform1i(gl.getUniformLocation(source, "uInterleaved"), planes.format === "NV12" ? 1 : 0);
  }

  // Draws over the scissor rectangles [x, y, width, height] of the picture.
  function drawRects(rects) {
    gl.enable(gl.SCISSOR_TEST);
    for (const [x, y, w, h] of rects) {
      if (w > 0 && h > 0) {
        gl.scissor(x, y, w, h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  return {
    canvas,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    // Takes a main view's luma within `rects` and its chroma for every 2x2
    // block they touch.
    applyMain(planes, rects) {
      fit(planes.width, planes.height);
      uploadView(planes);
      gl.bindVertexArray(vertexArray);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, width, height);
      useViewProgram(programs.main, planes);
      gl.colorMask(false, true, true, false);
      drawRects(rects.map(chromaBlockArea));
      gl.colorMask(true, false, false, false);
      drawRects(rects);
      gl.colorMask(true, true, true, true);
    },
    // Takes the chroma samples the main view leaves out from an auxiliary
    // view, within `rects`, packed as `layout` (avc444Layout) says.
    applyAuxiliary(layout, planes, rects) {
      fit(planes.width, planes.height);
      uploadView(planes);
      gl.bindVertexArray(vertexArray);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, width, height);
      useViewProgram(programs.auxiliary, planes);
      gl.uniform1i(gl.getUniformLocation(programs.auxiliary, "uLayout"), layout);
      // The view width W of 3.3.8.3.3: the coded width, whole macroblocks.
      gl.uniform1i(gl.getUniformLocation(programs.auxiliary, "uHalfWidth"), Math.ceil(planes.width / 16) * 8);
      gl.colorMask(false, true, true, false);
      drawRects(rects.map(chromaBlockArea));
      gl.colorMask(true, true, true, true);
    },
    // Renders `rects` of the picture onto `canvas`, at the same coordinates.
    paint(rects) {
      if (!width || !height) return;
      gl.bindVertexArray(vertexArray);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.useProgram(programs.convert);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, pictureTexture);
      gl.uniform1i(gl.getUniformLocation(programs.convert, "uPicture"), 0);
      gl.uniform1i(gl.getUniformLocation(programs.convert, "uHeight"), height);
      drawRects(rects.map(([x, y, w, h]) => [x, height - y - h, w, h]));
    },
    lost() {
      return gl.isContextLost();
    },
    close() {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

// The part of a rectangle the chroma of its 2x2 blocks covers: widened to
// even coordinates.
export function chromaBlockArea([x, y, width, height]) {
  const left = x & ~1;
  const top = y & ~1;
  const right = (x + width + 1) & ~1;
  const bottom = (y + height + 1) & ~1;
  return [left, top, right - left, bottom - top];
}

function defaultCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") {
    return new OffscreenCanvas(width, height);
  }
  const canvas = globalThis.document?.createElement("canvas");
  if (canvas) {
    canvas.width = width;
    canvas.height = height;
  }
  return canvas;
}

function texture(gl) {
  const result = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, result);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return result;
}

function program(gl, fragmentSource) {
  const result = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "shader compile failed");
    }
    gl.attachShader(result, shader);
  }
  gl.linkProgram(result);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(result) || "program link failed");
  }
  return result;
}
