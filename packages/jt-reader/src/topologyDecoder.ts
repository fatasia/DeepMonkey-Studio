import { JtFormatError } from "./binaryReader.js";

const MAX_ITEMS = 1_000_000;
const MAX_SLOTS = 8_000_000;

export interface JtTopologyPolygon {
  vertexIndices: number[];
  attributeIndices: Array<number | undefined>;
  group: number;
  flags: number;
}

export interface JtAttributeMaskLanes {
  small: readonly (readonly number[])[];
  context7Next30: readonly number[];
  context7Upper4: readonly number[];
  largeWords: readonly number[];
}

export interface JtTopologyInput {
  degrees: readonly (readonly number[])[];
  valences: readonly number[];
  groups: readonly number[];
  flags: readonly number[];
  splitFaces: readonly number[];
  splitPositions: readonly number[];
  attributeMasks: JtAttributeMaskLanes;
}

interface Vertex {
  faces: Array<number | undefined>;
  group: number;
  flags: number;
}

interface Face {
  vertices: Array<number | undefined>;
  empty: number;
  attributeMask: boolean[];
  attributes: number[];
}

class Symbols {
  readonly #degreePositions = Array.from({ length: 8 }, () => 0);
  readonly #maskPositions = Array.from({ length: 8 }, () => 0);
  #largeMaskPosition = 0;
  #vertexPosition = 0;
  #splitPosition = 0;

  constructor(private readonly input: JtTopologyInput) {}

  get hasVertices(): boolean {
    return this.#vertexPosition < this.input.valences.length;
  }

  vertex(): { valence: number; group: number; flags: number } {
    const valence = this.input.valences[this.#vertexPosition];
    const group = this.input.groups[this.#vertexPosition];
    const flags = this.input.flags[this.#vertexPosition];
    if (valence === undefined || group === undefined || flags === undefined || valence <= 0 || flags < 0 || flags > 0xffff) {
      throw new JtFormatError("JT 拓扑顶点符号无效");
    }
    this.#vertexPosition += 1;
    return { valence, group, flags };
  }

  degree(context: number): number {
    const lane = this.input.degrees[context];
    const position = this.#degreePositions[context];
    const value = lane?.[position ?? -1];
    if (value === undefined || position === undefined) throw new JtFormatError("JT 面度数符号不足");
    this.#degreePositions[context] = position + 1;
    return value;
  }

  split(): { offset: number; faceSlot: number } {
    const offset = this.input.splitFaces[this.#splitPosition];
    const faceSlot = this.input.splitPositions[this.#splitPosition];
    if (offset === undefined || faceSlot === undefined || offset <= 0 || faceSlot < 0) {
      throw new JtFormatError("JT 分裂面符号无效");
    }
    this.#splitPosition += 1;
    return { offset, faceSlot };
  }

  attributeMask(degree: number): boolean[] {
    if (degree <= 64) return this.#smallAttributeMask(degree);
    const wordCount = Math.ceil(degree / 32);
    const words = this.input.attributeMasks.largeWords.slice(
      this.#largeMaskPosition,
      this.#largeMaskPosition + wordCount,
    );
    if (words.length !== wordCount) throw new JtFormatError("JT 高度数面属性掩码不足");
    this.#largeMaskPosition += wordCount;
    const result = Array.from({ length: degree }, (_, bit) => ((words[Math.floor(bit / 32)]! >>> 0) & (1 << (bit % 32))) !== 0);
    const used = degree % 32;
    if (used !== 0 && (words.at(-1)! >>> used) !== 0) throw new JtFormatError("JT 高度数面属性掩码存在越界位");
    return result;
  }

  #smallAttributeMask(degree: number): boolean[] {
    const context = Math.min(Math.max(degree - 2, 0), 7);
    const position = this.#maskPositions[context];
    const lowValue = this.input.attributeMasks.small[context]?.[position ?? -1];
    if (lowValue === undefined || position === undefined) throw new JtFormatError("JT 面属性掩码不足");
    let mask = BigInt(lowValue >>> 0);
    if (context === 7) {
      const next = this.input.attributeMasks.context7Next30[position];
      const upper = this.input.attributeMasks.context7Upper4[position];
      if (next === undefined || upper === undefined || (next >>> 0) >= 2 ** 30 || (upper >>> 0) >= 16) {
        throw new JtFormatError("JT 第八组面属性掩码无效");
      }
      if ((lowValue >>> 0) >= 2 ** 30) throw new JtFormatError("JT 第八组低位掩码超出 30 位");
      mask |= BigInt(next >>> 0) << 30n;
      mask |= BigInt(upper >>> 0) << 60n;
    }
    if (degree < 64 && (mask >> BigInt(degree)) !== 0n) throw new JtFormatError("JT 面属性掩码存在越界位");
    this.#maskPositions[context] = position + 1;
    return Array.from({ length: degree }, (_, bit) => (mask & (1n << BigInt(bit))) !== 0n);
  }

  assertExhausted(): void {
    const degreesDone = this.#degreePositions.every((position, index) => position === this.input.degrees[index]?.length);
    const masksDone = this.#maskPositions.every((position, index) => position === this.input.attributeMasks.small[index]?.length);
    if (
      this.#vertexPosition !== this.input.valences.length
      || this.#vertexPosition !== this.input.groups.length
      || this.#vertexPosition !== this.input.flags.length
      || this.#splitPosition !== this.input.splitFaces.length
      || this.#splitPosition !== this.input.splitPositions.length
      || !degreesDone
      || !masksDone
      || this.#maskPositions[7] !== this.input.attributeMasks.context7Next30.length
      || this.#maskPositions[7] !== this.input.attributeMasks.context7Upper4.length
      || this.#largeMaskPosition !== this.input.attributeMasks.largeWords.length
    ) {
      throw new JtFormatError("JT 拓扑符号未被完整且唯一地消费");
    }
  }
}

class TopologyDecoder {
  readonly #symbols: Symbols;
  readonly #vertices: Vertex[] = [];
  readonly #faces: Face[] = [];
  readonly #active: number[] = [];
  readonly #removed: boolean[] = [];
  #slotCount = 0;
  #attributeCount = 0;

  constructor(input: JtTopologyInput) {
    this.#symbols = new Symbols(input);
  }

  run(): JtTopologyPolygon[] {
    while (this.#symbols.hasVertices) {
      const seed = this.#newVertex();
      for (let slot = 0; slot < this.#vertices[seed]!.faces.length; slot += 1) this.#activateFace(seed, slot);
      while (true) {
        const face = this.#nextActiveFace();
        if (face === undefined) break;
        while (true) {
          const slot = this.#faces[face]!.vertices.findIndex((vertex) => vertex === undefined);
          if (slot < 0) break;
          const vertex = this.#activateVertex(face, slot);
          this.#completeVertex(vertex, slot);
        }
        this.#removed[face] = true;
      }
    }
    this.#symbols.assertExhausted();
    if (this.#faces.some((face) => face.empty !== 0) || this.#vertices.some((vertex) => vertex.faces.includes(undefined))) {
      throw new JtFormatError("JT 拓扑重建后仍有未闭合槽位");
    }
    return this.#buildPolygons();
  }

  #newVertex(): number {
    const symbol = this.#symbols.vertex();
    if (this.#vertices.length >= MAX_ITEMS || symbol.valence > MAX_ITEMS) throw new JtFormatError("JT 拓扑顶点数量超限");
    this.#addSlots(symbol.valence);
    this.#vertices.push({ faces: Array.from({ length: symbol.valence }), group: symbol.group, flags: symbol.flags });
    return this.#vertices.length - 1;
  }

  #addSlots(count: number): void {
    this.#slotCount += count;
    if (this.#slotCount > MAX_SLOTS) throw new JtFormatError("JT 拓扑槽位数量超限");
  }

  #faceContext(vertexIndex: number): number {
    const vertex = this.#vertices[vertexIndex]!;
    const knownFaces = vertex.faces.filter((face) => face !== undefined) as number[];
    const totalDegree = knownFaces.reduce((sum, face) => sum + this.#faces[face]!.vertices.length, 0);
    const known = knownFaces.length;
    if (vertex.faces.length === 3) return totalDegree < known * 6 ? 0 : totalDegree === known * 6 ? 1 : 2;
    if (vertex.faces.length === 4) return totalDegree < known * 4 ? 3 : totalDegree === known * 4 ? 4 : 5;
    return vertex.faces.length === 5 ? 6 : 7;
  }

  #setVertexFace(vertex: number, slot: number, face: number): void {
    const target = this.#vertices[vertex]?.faces;
    if (!target || slot < 0 || slot >= target.length) throw new JtFormatError("JT 顶点-面槽位越界");
    if (target[slot] !== undefined && target[slot] !== face) throw new JtFormatError("JT 顶点-面槽位冲突");
    target[slot] = face;
  }

  #setFaceVertex(face: number, slot: number, vertex: number): void {
    const target = this.#faces[face];
    if (!target || slot < 0 || slot >= target.vertices.length) throw new JtFormatError("JT 面-顶点槽位越界");
    if (target.vertices[slot] !== undefined && target.vertices[slot] !== vertex) throw new JtFormatError("JT 面-顶点槽位冲突");
    if (target.vertices[slot] === undefined) target.empty -= 1;
    target.vertices[slot] = vertex;
  }

  #addVertexToFace(vertex: number, vertexFaceSlot: number, faceIndex: number, faceSlot: number): void {
    const face = this.#faces[faceIndex];
    const current = this.#vertices[vertex];
    if (!face || !current || face.vertices.length === 0 || faceSlot >= face.vertices.length) throw new JtFormatError("JT 邻接关系越界");
    this.#setFaceVertex(faceIndex, faceSlot, vertex);
    const clockwise = (faceSlot + face.vertices.length - 1) % face.vertices.length;
    const counterclockwise = (faceSlot + 1) % face.vertices.length;
    const clockwiseNeighbor = face.vertices[clockwise];
    if (clockwiseNeighbor !== undefined) {
      const neighbor = this.#vertices[clockwiseNeighbor]!;
      const shared = neighbor.faces.findIndex((item) => item === faceIndex);
      if (shared < 0) throw new JtFormatError("JT 顺时针邻接面缺失");
      const slot = (vertexFaceSlot + 1) % current.faces.length;
      if (current.faces[slot] === undefined) {
        const adjacent = (shared + neighbor.faces.length - 1) % neighbor.faces.length;
        const adjacentFace = neighbor.faces[adjacent];
        if (adjacentFace !== undefined) this.#setVertexFace(vertex, slot, adjacentFace);
      }
    }
    const counterNeighbor = face.vertices[counterclockwise];
    if (counterNeighbor !== undefined) {
      const neighbor = this.#vertices[counterNeighbor]!;
      const shared = neighbor.faces.findIndex((item) => item === faceIndex);
      if (shared < 0) throw new JtFormatError("JT 逆时针邻接面缺失");
      const slot = (vertexFaceSlot + current.faces.length - 1) % current.faces.length;
      if (current.faces[slot] === undefined) {
        const adjacentFace = neighbor.faces[(shared + 1) % neighbor.faces.length];
        if (adjacentFace !== undefined) this.#setVertexFace(vertex, slot, adjacentFace);
      }
    }
  }

  #activateFace(vertex: number, slot: number): number {
    const degree = this.#symbols.degree(this.#faceContext(vertex));
    if (degree !== 0) {
      if (degree < 0 || degree > MAX_ITEMS) throw new JtFormatError("JT 面度数无效");
      this.#addSlots(degree);
      const attributeMask = this.#symbols.attributeMask(degree);
      const faceAttributeCount = attributeMask.filter(Boolean).length;
      const attributes = Array.from({ length: faceAttributeCount }, (_, index) => this.#attributeCount + index);
      this.#attributeCount += faceAttributeCount;
      const faceIndex = this.#faces.length;
      this.#faces.push({ vertices: Array.from({ length: degree }), empty: degree, attributeMask, attributes });
      this.#removed.push(false);
      this.#setVertexFace(vertex, slot, faceIndex);
      this.#setFaceVertex(faceIndex, 0, vertex);
      this.#active.push(faceIndex);
      return faceIndex;
    }
    const split = this.#symbols.split();
    const activeIndex = this.#active.length - split.offset;
    const faceIndex = this.#active[activeIndex];
    if (faceIndex === undefined) throw new JtFormatError("JT 分裂面活动队列越界");
    this.#setVertexFace(vertex, slot, faceIndex);
    this.#addVertexToFace(vertex, slot, faceIndex, split.faceSlot);
    return faceIndex;
  }

  #activateVertex(face: number, faceSlot: number): number {
    const vertex = this.#newVertex();
    this.#setVertexFace(vertex, 0, face);
    this.#addVertexToFace(vertex, 0, face, faceSlot);
    return vertex;
  }

  #completeVertex(vertexIndex: number, vertexSlotOnFace: number): void {
    const vertex = this.#vertices[vertexIndex]!;
    let previousFace = vertex.faces[0];
    if (previousFace === undefined) throw new JtFormatError("JT 新顶点没有种子面");
    let previousSlot = vertexSlotOnFace;
    let slot = 1;
    while (slot < vertex.faces.length) {
      const nextFace = vertex.faces[slot];
      if (nextFace === undefined) break;
      const previous = this.#faces[previousFace]!;
      previousSlot = (previousSlot + previous.vertices.length - 1) % previous.vertices.length;
      const neighbor = previous.vertices[previousSlot];
      if (neighbor === undefined) break;
      const found = this.#faces[nextFace]!.vertices.findIndex((item) => item === neighbor);
      if (found < 0) throw new JtFormatError("JT 已知面之间缺少公共顶点");
      const nextSlot = (found + this.#faces[nextFace]!.vertices.length - 1) % this.#faces[nextFace]!.vertices.length;
      this.#addVertexToFace(vertexIndex, slot, nextFace, nextSlot);
      previousFace = nextFace;
      previousSlot = nextSlot;
      slot += 1;
    }
    if (slot === vertex.faces.length) return;
    const firstUnresolved = slot;
    previousFace = vertex.faces[0]!;
    previousSlot = vertexSlotOnFace;
    slot = vertex.faces.length - 1;
    while (slot >= firstUnresolved) {
      const nextFace = vertex.faces[slot];
      if (nextFace === undefined) break;
      const previous = this.#faces[previousFace]!;
      previousSlot = (previousSlot + 1) % previous.vertices.length;
      const neighbor = previous.vertices[previousSlot];
      if (neighbor === undefined) break;
      const found = this.#faces[nextFace]!.vertices.findIndex((item) => item === neighbor);
      if (found < 0) throw new JtFormatError("JT 反向已知面之间缺少公共顶点");
      const nextSlot = (found + 1) % this.#faces[nextFace]!.vertices.length;
      this.#addVertexToFace(vertexIndex, slot, nextFace, nextSlot);
      previousFace = nextFace;
      previousSlot = nextSlot;
      if (slot === firstUnresolved) return;
      slot -= 1;
    }
    for (let unresolved = firstUnresolved; unresolved <= slot; unresolved += 1) this.#activateFace(vertexIndex, unresolved);
  }

  #nextActiveFace(): number | undefined {
    while (this.#active.length > 0 && this.#removed[this.#active.at(-1)!]) this.#active.pop();
    let best: number | undefined;
    let index = this.#active.length;
    while (index > Math.max(0, this.#active.length - 16)) {
      index -= 1;
      const face = this.#active[index]!;
      if (this.#removed[face]) this.#active.splice(index, 1);
      else if (best === undefined || this.#faces[face]!.empty < this.#faces[best]!.empty) best = face;
    }
    return best;
  }

  #buildPolygons(): JtTopologyPolygon[] {
    return this.#vertices.map((vertex, vertexIndex) => {
      const faceIndices = vertex.faces as number[];
      const attributeIndices = faceIndices.map((faceIndex) => {
        const face = this.#faces[faceIndex]!;
        if (face.attributes.length === 0) return undefined;
        const vertexSlot = face.vertices.findIndex((candidate) => candidate === vertexIndex);
        if (vertexSlot < 0) throw new JtFormatError("JT 面中找不到已关联顶点");
        let attributeSlot = face.attributes.length - 1;
        for (let slot = 0; slot <= vertexSlot; slot += 1) {
          if (face.attributeMask[slot]) attributeSlot = (attributeSlot + 1) % face.attributes.length;
        }
        return face.attributes[attributeSlot];
      });
      return { vertexIndices: [...faceIndices], attributeIndices, group: vertex.group, flags: vertex.flags };
    });
  }
}

export function decodeJtTopology(input: JtTopologyInput): JtTopologyPolygon[] {
  if (
    input.degrees.length !== 8
    || input.attributeMasks.small.length !== 8
    || input.valences.length > MAX_ITEMS
    || input.groups.length !== input.valences.length
    || input.flags.length !== input.valences.length
  ) {
    throw new JtFormatError("JT 拓扑输入向量长度不一致");
  }
  return new TopologyDecoder(input).run();
}
