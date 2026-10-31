/**
 * 零依赖的 QR 码编码器（字节模式）。
 *
 * 用于扫码登录：把官方授权链接渲染成终端里可扫的二维码。
 *
 * 说明：
 *   - 只实现本项目需要的范围：版本 1~10、纠错等级 L/M，足够容纳登录链接；
 *   - 纯 JS 实现，不引入任何 npm 依赖，保证离线可用与零安装成本；
 *   - 与 QR 规范（ISO/IEC 18004）一致，输出可用任意扫码 App 识别。
 *
 * 参考实现结构：Nayuki 的 QR Code generator（算法为通用公开规范）。
 */

// ---------------------------------------------------------------- 码表

/** 纠错等级对应的格式信息位。 */
const EC_FORMAT_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

/**
 * 每个版本的总码字数（不含模式与长度头）。
 * 索引 0 未使用。
 */
const TOTAL_CODEWORDS = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
];

/**
 * 每个版本的纠错块结构：[每块纠错码字数, 组1块数, 组1数据码字数, 组2块数, 组2数据码字数]。
 * 组2 的块比组1 多 1 个数据码字（只有少数版本用到）。
 */
const BLOCK_STRUCTURE = {
  L: {
    1: [7, 1, 19, 0, 0],
    2: [10, 1, 34, 0, 0],
    3: [15, 1, 55, 0, 0],
    4: [20, 1, 80, 0, 0],
    5: [26, 1, 108, 0, 0],
    6: [18, 2, 68, 0, 0],
    7: [20, 2, 78, 0, 0],
    8: [24, 2, 97, 0, 0],
    9: [30, 2, 116, 0, 0],
    10: [18, 2, 68, 2, 69],
  },
  M: {
    1: [10, 1, 16, 0, 0],
    2: [16, 1, 28, 0, 0],
    3: [26, 1, 44, 0, 0],
    4: [18, 2, 32, 0, 0],
    5: [24, 2, 43, 0, 0],
    6: [16, 4, 27, 0, 0],
    7: [18, 4, 31, 0, 0],
    8: [22, 2, 38, 2, 39],
    9: [22, 3, 36, 2, 37],
    10: [26, 4, 43, 1, 44],
  },
};

/** 每个版本的定位图形中心坐标（版本 1 无定位图形）。 */
const ALIGNMENT_CENTERS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

// ---------------------------------------------------------------- 伽罗华域运算

/** GF(256) 的本原多项式 0x11D 对应的指数表与对数表。 */
const GF_EXP = new Uint8Array(256);
const GF_LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
})();

/** 伽罗华域乘法。 */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}

/** 伽罗华域除法（b 必须非零）。 */
function gfDiv(a, b) {
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] - GF_LOG[b] + 255) % 255];
}

/**
 * 多项式长除法的余数：self mod other。
 *
 * 系数按**低次在前**排列：长度为 n 的数组表示
 * a[0] + a[1]·x + ... + a[n-1]·x^(n-1)。
 *
 * 每轮消去首项：ratio = log(self[0]) - log(other[0])，
 * 把 other 的 ratio 倍从 self 前 other.length 项里异或掉，
 * 再去掉已经归零的首项，重复直到长度不足。
 */
function polyMod(self, other) {
  const remainder = self.slice();
  const divisorLength = other.length;
  const divisorLead = other[0];

  while (remainder.length >= divisorLength) {
    // 去掉前导零（低次在前时，前导零在末尾）
    let start = 0;
    while (start < remainder.length && remainder[start] === 0) start++;
    if (start > 0) {
      remainder.splice(0, start);
      if (remainder.length < divisorLength) break;
    }

    const ratio = GF_LOG[remainder[0]] - GF_LOG[divisorLead];
    for (let i = 0; i < divisorLength; i++) {
      remainder[i] ^= gfMul(other[i], GF_EXP[ratio]);
    }
    // 首项已归零，移除它
    remainder.shift();
  }
  return remainder;
}

/**
 * 生成 RS 生成多项式（低次在前）。
 *
 * g(x) = ∏ (x + α^i)，i = 0 .. degree-1。
 */
function rsGenerator(degree) {
  let result = [1];
  for (let i = 0; i < degree; i++) {
    // 乘以 (1 + α^i·x)
    const next = new Array(result.length + 1).fill(0);
    for (let j = 0; j < result.length; j++) {
      next[j] ^= result[j];
      next[j + 1] ^= gfMul(result[j], GF_EXP[i]);
    }
    result = next;
  }
  return result;
}

/** 计算一个数据块的 Reed-Solomon 纠错码字。 */
function rsEncode(data, ecCount) {
  const generator = rsGenerator(ecCount);
  // 数据多项式左移 ecCount 位（即乘以 x^ecCount）
  const raw = data.concat(new Array(ecCount).fill(0));
  const remainder = polyMod(raw, generator);
  // 取末尾 ecCount 个系数作为纠错码
  const offset = remainder.length - ecCount;
  const out = [];
  for (let i = 0; i < ecCount; i++) {
    const index = i + offset;
    out.push(index >= 0 ? remainder[index] : 0);
  }
  return out;
}

// ---------------------------------------------------------------- 位流

class BitBuffer {
  constructor() {
    this.bits = [];
  }

  push(value, length) {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length() {
    return this.bits.length;
  }
}

// ---------------------------------------------------------------- 主流程

/**
 * 把文本编码成 QR 模块矩阵。
 *
 * @param {string} text 要编码的文本（会按 UTF-8 字节处理）
 * @param {{ecLevel?: 'L'|'M'|'Q'|'H', minVersion?: number}} [options]
 * @returns {{size: number, modules: boolean[][], version: number}}
 */
export function encodeQr(text, options = {}) {
  const ecLevel = options.ecLevel ?? 'M';
  const minVersion = options.minVersion ?? 1;
  if (!Object.prototype.hasOwnProperty.call(EC_FORMAT_BITS, ecLevel)) {
    throw new Error(`unsupported EC level: ${ecLevel}`);
  }

  const bytes = Array.from(new TextEncoder().encode(text));
  const version = pickVersion(bytes.length, ecLevel, minVersion);
  const { ecCount, blocks } = buildBlocks(version, ecLevel, bytes);

  const dataCodewords = interleave(blocks, ecCount);
  const matrix = new Matrix(version);

  // 功能图形
  drawFunctionPatterns(matrix);
  // 数据 + 掩码
  drawCodewords(matrix, dataCodewords);
  const mask = selectMask(matrix, version, ecLevel);
  applyMask(matrix, mask);
  drawFormatBits(matrix, ecLevel, mask);
  if (version >= 7) drawVersionBits(matrix, version);

  return { size: matrix.size, modules: matrix.modules, version, mask };
}

/** 选择能容纳数据的最小版本。 */
function pickVersion(byteLength, ecLevel, minVersion) {
  for (let version = Math.max(1, minVersion); version <= 10; version++) {
    const structure = BLOCK_STRUCTURE[ecLevel][version];
    if (!structure) continue;
    const capacity = structure[1] * structure[2] + structure[3] * structure[4];
    // 字节模式：4 位模式 + 8/16 位长度
    const lengthBits = version <= 9 ? 8 : 16;
    const needed = 4 + lengthBits + byteLength * 8;
    if (needed <= capacity * 8) return version;
  }
  throw new Error(
    `data too long for QR (${byteLength} bytes); supported up to version 10 at EC level ${ecLevel}`,
  );
}

/** 构造纠错块。 */
function buildBlocks(version, ecLevel, bytes) {
  const [ecCount, group1Blocks, group1Data, group2Blocks, group2Data] =
    BLOCK_STRUCTURE[ecLevel][version];

  const totalData = group1Blocks * group1Data + group2Blocks * group2Data;
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4); // 字节模式
  buffer.push(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) buffer.push(byte, 8);

  // 结束符
  const capacityBits = totalData * 8;
  buffer.push(0, Math.min(4, capacityBits - buffer.length));
  // 补齐到字节
  if (buffer.length % 8 !== 0) buffer.push(0, 8 - (buffer.length % 8));
  // 填充字节
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (buffer.length < capacityBits) {
    buffer.push(padBytes[padIndex % 2], 8);
    padIndex++;
  }

  const dataCodewords = [];
  for (let i = 0; i < buffer.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | buffer.bits[i + j];
    dataCodewords.push(byte);
  }

  // 切块
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < group1Blocks; i++) {
    blocks.push(dataCodewords.slice(offset, offset + group1Data));
    offset += group1Data;
  }
  for (let i = 0; i < group2Blocks; i++) {
    blocks.push(dataCodewords.slice(offset, offset + group2Data));
    offset += group2Data;
  }

  return { ecCount, blocks };
}

/** 交织数据码字与纠错码字。 */
function interleave(blocks, ecCount) {
  const maxData = Math.max(...blocks.map((b) => b.length));
  const result = [];
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) {
      if (i < block.length) result.push(block[i]);
    }
  }
  for (let i = 0; i < ecCount; i++) {
    for (const block of blocks) {
      result.push(rsEncode(block, ecCount)[i]);
    }
  }
  return result;
}

// ---------------------------------------------------------------- 矩阵

class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  set(x, y, dark) {
    this.modules[y][x] = dark;
  }

  setFunction(x, y, dark) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  /** 只把该位置标记为功能模块，保留原有值（用于定时图形与格式信息区交叠处）。 */
  markFunction(x, y) {
    this.isFunction[y][x] = true;
  }
}

/** 绘制定位图形、分隔符、定时图形、定位图形、格式信息占位。 */
function drawFunctionPatterns(matrix) {
  const { size } = matrix;

  // 定位图形 + 分隔符（严格按 QR 规范：7x7 外框，内部 3x3 实心，
  // 两者之间为空白，分隔符同样为空白）
  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      const y = row + r;
      if (y < 0 || y >= size) continue;
      for (let c = -1; c <= 7; c++) {
        const x = col + c;
        if (x < 0 || x >= size) continue;
        const dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        matrix.setFunction(x, y, dark);
      }
    }
  }

  // 定位图形（校正图形）
  const centers = ALIGNMENT_CENTERS[matrix.version];
  for (const cy of centers) {
    for (const cx of centers) {
      // 跳过与三个定位图形重叠的位置
      const nearFinder =
        (cx === 6 && cy === 6) ||
        (cx === 6 && cy === size - 7) ||
        (cx === size - 7 && cy === 6);
      if (nearFinder) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const edge = dx === -2 || dx === 2 || dy === -2 || dy === 2;
          const center = dx === 0 && dy === 0;
          matrix.setFunction(cx + dx, cy + dy, edge || center);
        }
      }
    }
  }

  // 定时图形：第 6 行与第 6 列，跳过已被其它图形占用的位置
  for (let i = 8; i < size - 8; i++) {
    if (!matrix.isFunction[i][6]) matrix.setFunction(6, i, i % 2 === 0);
    if (!matrix.isFunction[6][i]) matrix.setFunction(i, 6, i % 2 === 0);
  }

  // 格式信息区：只标记为功能模块（避免数据写入），不改模块值。
  // (8,6) 与 (6,8) 已被定时图形占用，这里只打标记、不覆盖。
  for (let i = 0; i <= 8; i++) {
    matrix.markFunction(8, i);
    matrix.markFunction(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    matrix.markFunction(size - 1 - i, 8);
    matrix.markFunction(8, size - 1 - i);
  }
  // 固定的黑模块
  matrix.setFunction(8, size - 8, true);

  // 版本信息区（版本 >= 7 才有 18 个模块）：必须先标记为功能模块，
  // 否则数据位会先被填进来，随后又被版本信息覆盖，导致该区域数据丢失。
  if (matrix.version >= 7) {
    for (let i = 0; i < 18; i++) {
      matrix.markFunction((i % 3) + size - 11, Math.floor(i / 3));
      matrix.markFunction(Math.floor(i / 3), (i % 3) + size - 11);
    }
  }
}

/** 按之字形填入数据码字。 */
function drawCodewords(matrix, codewords) {
  const { size } = matrix;
  const totalBits = codewords.length * 8;

  // 之字形填充：从右下角开始，两列一组，行方向自下而上交替。
  let bitIndex = 0;
  let row = size - 1;
  let direction = -1;

  // 列对的取值序列固定为 (size-1, size-2) ... 直到 (1, 0)，
  // 其中第 6 列是定时图形，整对左移一列跳过它。
  // 注意：跳过只影响当次配对，不改变后续列对的推进节奏。
  for (let colIndex = size - 1; colIndex > 0; colIndex -= 2) {
    const col = colIndex <= 6 ? colIndex - 1 : colIndex;
    const pair = [col, col - 1];
    for (;;) {
      for (const x of pair) {
        if (matrix.isFunction[row][x]) continue;
        let dark = false;
        if (bitIndex < totalBits) {
          const byte = codewords[bitIndex >>> 3];
          dark = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
        matrix.set(x, row, dark);
      }
      row += direction;
      if (row < 0 || row >= size) {
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }
}

/** 8 种掩码的判定函数。 */
const MASK_FUNCTIONS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(matrix, mask) {
  const fn = MASK_FUNCTIONS[mask];
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (matrix.isFunction[y][x]) continue;
      if (fn(x, y)) matrix.modules[y][x] = !matrix.modules[y][x];
    }
  }
}

/** 计算罚分，选出最优掩码。 */
function selectMask(matrix, version, ecLevel) {
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(matrix, mask);
    // 掩码选择阶段格式位填 0（占位），保证各候选掩码的罚分可比；
    // 真实格式位等掩码定下来之后再写。
    drawFormatBits(matrix, ecLevel, mask, true);
    if (version >= 7) drawVersionBits(matrix, version, true);
    const penalty = penaltyParts(matrix).total;
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    // 还原
    applyMask(matrix, mask);
  }
  return bestMask;
}

function penaltyParts(matrix) {
  const { size, modules } = matrix;
  let penalty = 0;

  // 规则 1：行 / 列中同色连续 5 个及以上，每段罚 (长度 - 2)
  const runCounts = new Map();
  const addRun = (length) => {
    if (length >= 5) runCounts.set(length, (runCounts.get(length) ?? 0) + 1);
  };
  for (let y = 0; y < size; y++) {
    let color = modules[y][0];
    let length = 0;
    for (let x = 0; x < size; x++) {
      if (modules[y][x] === color) {
        length++;
      } else {
        addRun(length);
        length = 1;
        color = modules[y][x];
      }
    }
    addRun(length);
  }
  for (let x = 0; x < size; x++) {
    let color = modules[0][x];
    let length = 0;
    for (let y = 0; y < size; y++) {
      if (modules[y][x] === color) {
        length++;
      } else {
        addRun(length);
        length = 1;
        color = modules[y][x];
      }
    }
    addRun(length);
  }
  const r1 = [...runCounts.entries()].reduce((acc, [length, count]) => acc + count * (length - 2), 0);
  penalty += r1;

  // 规则 2：2x2 同色块，每块罚 3
  let r2 = 0;
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        r2 += 3;
      }
    }
  }
  penalty += r2;

  // 规则 3：1:1:3:1:1 特征模式（前后各带 4 个浅色），每处罚 40
  //   10111010000 / 00001011101
  const matchesPattern = (get, start) =>
    !get(start + 1) &&
    get(start + 4) &&
    !get(start + 5) &&
    get(start + 6) &&
    !get(start + 9) &&
    ((get(start) && get(start + 2) && get(start + 3) &&
      !get(start + 7) && !get(start + 8) && !get(start + 10)) ||
      (!get(start) && !get(start + 2) && !get(start + 3) &&
        get(start + 7) && get(start + 8) && get(start + 10)));

  let r3 = 0;
  // 使用 Horspool 跳跃：命中后若第 10 位为深色则跳 4 格，否则跳 1 格，
  // 这样既能覆盖重叠匹配，又不必逐格扫描。
  const scanLine = (get) => {
    let count = 0;
    for (let i = 0; i + 10 < size; i++) {
      if (matchesPattern(get, i)) {
        count += 40;
        // 命中后按 Horspool 规则推进
        i += get(i + 10) ? 3 : 0; // 下一轮 i 会自增 1
      }
    }
    return count;
  };
  for (let y = 0; y < size; y++) {
    r3 += scanLine((i) => modules[y][i]);
  }
  for (let x = 0; x < size; x++) {
    r3 += scanLine((i) => modules[i][x]);
  }
  penalty += r3;

  // 规则 4：深色模块占比偏离 50%，每偏离 5% 罚 10
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
    }
  }
  const percent = (dark * 100) / (size * size);
  const r4 = Math.floor(Math.abs(percent - 50) / 5) * 10;
  penalty += r4;

  return { L1: r1, L2: r2, L3: r3, L4: r4, total: penalty };
}

/** 写入格式信息（15 位 BCH 码）。 */
function drawFormatBits(matrix, ecLevel, mask, test = false) {
  const { size } = matrix;
  const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask;
  const bits = test ? 0 : bchTypeInfo(data);

  for (let i = 0; i <= 5; i++) matrix.setFunction(8, i, ((bits >>> i) & 1) !== 0);
  matrix.setFunction(8, 7, ((bits >>> 6) & 1) !== 0);
  matrix.setFunction(8, 8, ((bits >>> 7) & 1) !== 0);
  matrix.setFunction(7, 8, ((bits >>> 8) & 1) !== 0);
  for (let i = 9; i < 15; i++) matrix.setFunction(14 - i, 8, ((bits >>> i) & 1) !== 0);

  for (let i = 0; i < 8; i++) {
    matrix.setFunction(size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
  }
  for (let i = 8; i < 15; i++) {
    matrix.setFunction(8, size - 15 + i, ((bits >>> i) & 1) !== 0);
  }
  // 固定黑模块（test 模式下置 0，与参考实现一致）
  matrix.setFunction(8, size - 8, !test);
}

/**
 * 格式信息的 BCH(15,5) 编码。
 *
 * 生成多项式 G15 = 0x537，掩码常量 0x5412。
 */
function bchTypeInfo(data) {
  const generator = 0x537;
  let remainder = data << 10;
  for (let i = 14; i >= 10; i--) {
    if (((remainder >>> i) & 1) === 0) continue;
    remainder ^= generator << (i - 10);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

/** 写入版本信息（版本 >= 7 时需要，18 位 BCH 码）。 */
function drawVersionBits(matrix, version, test = false) {
  const { size } = matrix;
  const bits = test ? 0 : bchTypeNumber(version);

  // 两份拷贝：右上角（3 列 x 6 行）与左下角（6 行 x 3 列）
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) !== 0;
    // 右上角：行 = i/3，列 = i%3 + size-11
    matrix.setFunction((i % 3) + size - 11, Math.floor(i / 3), bit);
    // 左下角：行 = i%3 + size-11，列 = i/3
    matrix.setFunction(Math.floor(i / 3), (i % 3) + size - 11, bit);
  }
}

/**
 * 版本信息的 BCH(18,6) 编码。
 *
 * 用多项式长除法求余，与格式信息同一套思路。
 */
function bchTypeNumber(data) {
  const generator = [0x1f25];
  let remainder = data << 12;
  const degree = 12;
  for (let i = degree + 6; i >= degree; i--) {
    if (((remainder >>> i) & 1) === 0) continue;
    remainder ^= generator[0] << (i - degree);
  }
  return (data << 12) | remainder;
}

// ---------------------------------------------------------------- 终端渲染

/**
 * 把 QR 矩阵渲染成终端可扫的字符块。
 *
 * 用上半块字符把两行压成一行，这样在常见等宽终端里仍然是正方形。
 *
 * @param {{size: number, modules: boolean[][]}} qr
 * @param {{dark?: string, light?: string, quiet?: number}} [options]
 * @returns {string}
 */
export function renderQrTerminal(qr, options = {}) {
  const dark = options.dark ?? '██';
  const light = options.light ?? '  ';
  const quiet = options.quiet ?? 2;
  const { size, modules } = qr;

  const lines = [];
  const empty = light.repeat(size + quiet * 2);
  for (let i = 0; i < quiet; i++) lines.push(empty);

  for (let y = 0; y < size; y += 2) {
    let line = light.repeat(quiet);
    for (let x = 0; x < size; x++) {
      const top = modules[y][x];
      const bottom = y + 1 < size ? modules[y + 1][x] : false;
      if (top && bottom) line += ' ';
      else if (top) line += '▀';
      else if (bottom) line += '▄';
      else line += ' ';
    }
    line += light.repeat(quiet);
    lines.push(line);
  }
  for (let i = 0; i < quiet; i++) lines.push(empty);

  return lines.join('\n');
}

/**
 * 一步生成可直接打印的二维码文本。
 *
 * @param {string} text
 * @param {{ecLevel?: 'L'|'M'|'Q'|'H'}} [options]
 * @returns {string}
 */
export function qrToTerminal(text, options = {}) {
  const qr = encodeQr(text, options);
  return renderQrTerminal(qr, options);
}










