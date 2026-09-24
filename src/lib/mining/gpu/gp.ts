/**
 * 遗传规划 —— public/pykernel/factor_lab/search.py 树操作部分的 TS 移植
 *
 * 仅供 GPU 粗排路径使用(JS 拥有树的生成/交叉/变异/锦标赛);演化轨迹
 * 不要求与 Python 逐位一致——粗排只决定哪些候选进入 Pyodide f64 精算,
 * 对外暴露的一切数字都出自内核。RNG 用 mulberry32,行为独立于 Python。
 */

import { FEAT_OFFSET, MAX_TOKENS, OPS, tokensGpuSupported } from "./tokens"

/** mulberry32 —— [0,1) 均匀分布,种子化可复现 */
export class Rng {
  private s: number
  constructor(seed: number) {
    this.s = seed >>> 0
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  randrange(n: number): number {
    return Math.min(n - 1, Math.floor(this.next() * n))
  }
  choice<T>(arr: readonly T[]): T {
    return arr[this.randrange(arr.length)]
  }
  /** 无放回取 k 个(部分 Fisher-Yates) */
  sample<T>(arr: readonly T[], k: number): T[] {
    const copy = [...arr]
    const n = Math.min(k, copy.length)
    for (let i = 0; i < n; i++) {
      const j = i + this.randrange(copy.length - i)
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
    }
    return copy.slice(0, n)
  }
}

export type Tree =
  | ["feat", number]
  | ["op", number, Tree, ...Tree[]]

export function cloneTree(tree: Tree): Tree {
  if (tree[0] === "feat") return ["feat", tree[1]]
  return ["op", tree[1], ...(tree.slice(2) as Tree[]).map(cloneTree)] as Tree
}

/** 随机生成合法语法树(与 _random_tree 同结构;仅用 GPU 支持的算子) */
export function randomTree(
  depth: number,
  featN: number,
  opOne: readonly number[],
  opTwo: readonly number[],
  rng: Rng,
): Tree {
  if (depth <= 0 || (depth < 3 && rng.next() < 0.4)) {
    return ["feat", rng.randrange(featN)]
  }
  if (opTwo.length > 0 && rng.next() < 0.3) {
    return [
      "op",
      rng.choice(opTwo),
      randomTree(depth - 1, featN, opOne, opTwo, rng),
      randomTree(depth - 1, featN, opOne, opTwo, rng),
    ]
  }
  return ["op", rng.choice(opOne), randomTree(depth - 1, featN, opOne, opTwo, rng)]
}

export function treeToTokens(tree: Tree): number[] {
  if (tree[0] === "feat") return [tree[1]]
  const out: number[] = []
  for (const child of tree.slice(2) as Tree[]) out.push(...treeToTokens(child))
  out.push(tree[1] + FEAT_OFFSET)
  return out
}

export function tokensToTree(tokens: number[], featCount: number): Tree | null {
  const stack: Tree[] = []
  for (const t of tokens) {
    if (t < FEAT_OFFSET) {
      if (t < 0 || t >= featCount) return null
      stack.push(["feat", t])
      continue
    }
    const op = OPS[t - FEAT_OFFSET]
    if (!op) return null
    if (stack.length < op.arity) return null
    if (op.arity === 1) {
      stack.push(["op", t - FEAT_OFFSET, stack.pop()!])
    } else {
      const b = stack.pop()!
      const a = stack.pop()!
      stack.push(["op", t - FEAT_OFFSET, a, b])
    }
  }
  return stack.length === 1 ? stack[0] : null
}

function allNodes(tree: Tree, out: Tree[]): Tree[] {
  out.push(tree)
  if (tree[0] === "op") for (const c of tree.slice(2) as Tree[]) allNodes(c, out)
  return out
}

function replaceRandom(tree: Tree, donor: Tree, rng: Rng): Tree {
  const nodes = allNodes(tree, [])
  const target = rng.choice(nodes)
  // 与 Python 原地替换([])等价:直接替换引用所在节点的内容
  const donorClone = cloneTree(donor)
  target.length = 0
  ;(target as unknown[]).push(...donorClone)
  return tree
}

export function crossover(mom: Tree, dad: Tree, rng: Rng): Tree {
  const child = cloneTree(mom)
  const donor = rng.choice(allNodes(dad, []))
  return replaceRandom(child, donor, rng)
}

export function mutate(
  tree: Tree,
  featN: number,
  opOne: readonly number[],
  opTwo: readonly number[],
  rng: Rng,
  maxDepth: number,
): Tree {
  const depth = 2 + rng.randrange(maxDepth - 1) // randrange(2, max_depth+1)
  const donor = randomTree(depth, featN, opOne, opTwo, rng)
  return replaceRandom(tree, donor, rng)
}

export function tournament(
  scored: { comp: number; tree: Tree }[],
  rng: Rng,
  k = 3,
): Tree {
  const sample = rng.sample(scored, Math.min(k, scored.length))
  return sample.reduce((best, x) => (x.comp > best.comp ? x : best)).tree
}

// ── 进化增强(evolve_v2;与内核 search.py 同名算子语义同构)────────────

/** 算子族:去掉窗口/阶数后缀(TS_MA_5 → TS_MA,DELTA_1 → DELTA) */
function opFamily(name: string): string {
  const i = name.lastIndexOf("_")
  return i > 0 && /^\d+$/.test(name.slice(i + 1)) ? name.slice(0, i) : name
}

const OP_FAMILY: readonly string[] = OPS.map((o) => opFamily(o.name))

/** 点变异:随机节点换同元数算子(半数概率限同族,即换窗口)/换特征 */
export function pointMutate(
  tree: Tree,
  featN: number,
  opOne: readonly number[],
  opTwo: readonly number[],
  rng: Rng,
): Tree {
  const node = rng.choice(allNodes(tree, []))
  if (node[0] === "feat") {
    node[1] = rng.randrange(featN)
    return tree
  }
  const pool = node.length === 3 ? opOne : opTwo
  const cur = node[1]
  const same = pool.filter((o) => OP_FAMILY[o] === OP_FAMILY[cur] && o !== cur)
  if (same.length > 0 && rng.next() < 0.5) node[1] = rng.choice(same)
  else if (pool.length > 0) node[1] = rng.choice(pool)
  return tree
}

/** 收缩变异:随机算子节点被自身的某个后代替换(公式瘦身,对抗膨胀) */
export function shrinkMutate(
  tree: Tree,
  featN: number,
  opOne: readonly number[],
  opTwo: readonly number[],
  rng: Rng,
): Tree {
  const ops = allNodes(tree, []).filter((n) => n[0] === "op")
  if (ops.length === 0) return pointMutate(tree, featN, opOne, opTwo, rng)
  const target = rng.choice(ops)
  const donor = cloneTree(rng.choice(allNodes(target, []).slice(1)))
  target.length = 0
  ;(target as unknown[]).push(...donor)
  return tree
}

/** 变异混合:40% 子树替换(探索)/40% 点变异(微调)/20% 收缩(瘦身) */
export function mutateV2(
  tree: Tree,
  featN: number,
  opOne: readonly number[],
  opTwo: readonly number[],
  rng: Rng,
  maxDepth: number,
): Tree {
  const r = rng.next()
  if (r < 0.4) return mutate(tree, featN, opOne, opTwo, rng, maxDepth)
  if (r < 0.8) return pointMutate(tree, featN, opOne, opTwo, rng)
  return shrinkMutate(tree, featN, opOne, opTwo, rng)
}

/** GPU 路径的可用算子集(排除 EMA 等不支持算子) */
export function gpuOpSets(): { opOne: number[]; opTwo: number[] } {
  const opOne: number[] = []
  const opTwo: number[] = []
  OPS.forEach((o, i) => {
    if (o.kind === "ema") return
    ;(o.arity === 2 ? opTwo : opOne).push(i)
  })
  return { opOne, opTwo }
}

/** 随机树重试:token 超 MAX_TOKENS 或栈深超限时重生成(上限 8 次) */
export function randomTreeGpuSafe(
  depth: number,
  featN: number,
  opOne: readonly number[],
  opTwo: readonly number[],
  rng: Rng,
): Tree {
  for (let i = 0; i < 8; i++) {
    const tree = randomTree(depth, featN, opOne, opTwo, rng)
    if (tokensGpuSupported(treeToTokens(tree), featN)) return tree
  }
  return ["feat", rng.randrange(featN)]
}

/** 交叉/变异结果可能超限,超限时回退母体(保代不中断) */
export function gpuSafeChild(
  child: Tree,
  fallback: Tree,
  featN: number,
): Tree {
  return tokensGpuSupported(treeToTokens(child), featN) ? child : fallback
}

export const GP_MAX_TOKENS = MAX_TOKENS
