const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const OUTPUT_DIR = path.join(__dirname, "..", "out");
const NEXT_STATIC_DIR = path.join(OUTPUT_DIR, "_next", "static");

// ============================================================
// Utility
// ============================================================

const computeHash = (content) => {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
};

// ============================================================
// 1. webpack runtime の chunk ID マップ順序を正規化
// ============================================================

const stabilizeWebpackRuntime = (content) => {
  return content.replace(/var e=\{(\d+:0(?:,\d+:0)*)\}/g, (_match, inner) => {
    const entries = inner.split(",");
    const sorted = entries
      .map((e) => {
        const [k, v] = e.split(":");
        return { key: parseInt(k, 10), value: v };
      })
      .sort((a, b) => a.key - b.key)
      .map((e) => `${e.key}:${e.value}`)
      .join(",");
    return `var e={${sorted}}`;
  });
};

// ============================================================
// 2. CSS ルール順序を正規化
// ============================================================

const stabilizeCss = (content) => {
  const rules = [];
  let depth = 0;
  let current = "";

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    current += ch;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        rules.push(current.trim());
        current = "";
      }
    }
  }
  if (current.trim()) {
    rules.push(current.trim());
  }

  rules.sort();
  return rules.join("");
};

// ============================================================
// 2.5. 互換チャンクの等価マップ構築
// ============================================================

/**
 * レイアウトチャンクファイルを走査し、同一モジュールを登録する
 * 互換チャンクのマップを構築する。
 * 例: c/(non-action-header-with-footer)/layout と c/(default)/layout が
 * 同じモジュールを持つ場合、常にアルファベット順で最初のものを使う。
 *
 * 返値: Map<fromPairStr, toPairStr>
 *   キー: '"chunkId","static/chunks/filePath"'
 *   値:   '"canonicalChunkId","static/chunks/canonicalFilePath"'
 */
const buildChunkEquivalenceMap = () => {
  const chunksDir = path.join(NEXT_STATIC_DIR, "chunks", "app");
  if (!fs.existsSync(chunksDir)) return null;

  // レイアウトチャンクを収集
  const layoutChunks = [];
  const scanDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name.startsWith("layout-") && entry.name.endsWith(".js")) {
        const content = fs.readFileSync(fullPath, "utf-8");
        // チャンクIDを抽出: push([[chunkId],...])
        const chunkIdMatch = content.match(/push\(\[\[(\d+)\]/);
        // モジュール情報を抽出
        const moduleMatch = content.match(/a\.s=_\);a\.O\(0,\[([\d,]*)\],\(\)=>_\((0x[0-9a-f]+)\)/);
        if (chunkIdMatch && moduleMatch) {
          const chunkId = chunkIdMatch[1];
          const deps = moduleMatch[1];
          const moduleStart = moduleMatch[2];
          const relPath = path.relative(path.join(NEXT_STATIC_DIR, "chunks"), fullPath);
          layoutChunks.push({
            path: relPath,
            chunkId,
            deps,
            moduleStart,
          });
        }
      }
    }
  };
  scanDir(chunksDir);

  // 同一 moduleStart + deps を持つチャンクをグループ化
  const groups = new Map();
  for (const lc of layoutChunks) {
    const key = `${lc.moduleStart}|${lc.deps}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(lc);
  }

  // グループ内で2つ以上あるものについて、パス順で最初のものに正規化
  // チャンクID + パスのペアで置換マップを構築
  const equivalenceMap = new Map();
  for (const [, chunks] of groups) {
    if (chunks.length <= 1) continue;
    chunks.sort((a, b) => a.path.localeCompare(b.path));
    const canonical = chunks[0];
    const canonicalPair = `"${canonical.chunkId}","static/chunks/${canonical.path}"`;
    for (let i = 1; i < chunks.length; i++) {
      const fromPair = `"${chunks[i].chunkId}","static/chunks/${chunks[i].path}"`;
      equivalenceMap.set(fromPair, canonicalPair);
    }
  }

  return equivalenceMap.size > 0 ? equivalenceMap : null;
};

// ============================================================
// 3. RSC ペイロード (txt ファイル) の正規化
// ============================================================

/**
 * RSC行をパースする
 * 形式: "rowId:content" (rowIdは16進数) or ":HL[...]" (ヒント行)
 * 注意: 行の内容が改行で分割されている場合があるため、
 *       行IDのない行は直前の行の続きとして結合する
 */
const parseRscRows = (text) => {
  const lines = text.split("\n").filter((l) => l.length > 0);
  const rows = [];
  for (const line of lines) {
    // 行ID付き行 (例: "f:I[...]", "0:{...}")
    const m = line.match(/^([0-9a-f]+):(.*)/);
    if (m) {
      rows.push({ id: m[1], content: m[2] });
    } else if (line.startsWith(":")) {
      // ヒント行 (:HL[...])
      rows.push({ id: null, content: line });
    } else if (rows.length > 0) {
      // 行IDなし → 直前の行の続き（改行で分割されたチャンクリスト等）
      rows[rows.length - 1].content += "\n" + line;
    }
  }
  return rows;
};

/**
 * モジュール定義行かどうか判定
 * 形式: I[moduleId,[chunks],name]
 */
const isModuleRow = (content) => {
  return /^I\[\d+,/.test(content);
};

/**
 * モジュール定義からモジュールIDを取得
 */
const getModuleId = (content) => {
  const m = content.match(/^I\[(\d+),/);
  return m ? m[1] : null;
};

/**
 * RSC行0 (ツリーデータ) 内のデータ行参照をインライン化する
 *
 * out-1: row 0 に "$Ld" があり、row d に実データがある
 * out-2: row 0 に実データが直接インラインされている
 * → 常にインライン化して統一する
 */
const inlineDataRows = (treeContent, dataRows) => {
  let result = treeContent;
  let changed = true;

  // dataRows: Map<id, content>
  while (changed) {
    changed = false;
    for (const [id, content] of dataRows) {
      // "$LXX" (引用符付きの参照) を実データで置換
      const ref = `"$L${id}"`;
      if (result.includes(ref)) {
        result = result.replaceAll(ref, content);
        dataRows.delete(id);
        changed = true;
      }
    }
  }
  return result;
};

/**
 * RSCペイロードを正規化する
 *
 * 非決定性の原因:
 * 1. モジュール定義行のrow IDが毎回異なる
 * 2. データがrow 0にインライン or 別行に分離される
 * 3. データ行のrow IDが毎回異なる
 *
 * 対策:
 * - 全行のIDを単一カウンタから再割り当て（衝突を防止）
 * - データ行をrow 0にインライン化（構造差異を解消）
 * - プレースホルダ方式で連鎖置換を防止
 */
const stabilizeRscPayload = (text, chunkEquivalenceMap, existingCssFiles) => {
  const rows = parseRscRows(text);

  // 行を分類
  const moduleRows = []; // {id, content, moduleId}
  let treeRow = null; // row 0
  const dataRows = []; // {id, content}
  const hintRows = []; // :HL[...] 等
  let hasFragmentRow = false;

  for (const row of rows) {
    if (row.id === null) {
      hintRows.push(row.content);
    } else if (row.id === "0") {
      treeRow = row;
    } else if (row.content === '"$Sreact.fragment"') {
      hasFragmentRow = true;
    } else if (isModuleRow(row.content)) {
      moduleRows.push({
        id: row.id,
        content: row.content,
        moduleId: getModuleId(row.content),
      });
    } else {
      dataRows.push({ id: row.id, content: row.content });
    }
  }

  // === Step 1: 全行に決定的なIDを割り当て ===

  // モジュール行をソート（moduleIdで数値順、同一IDはコンテンツで字句順）
  moduleRows.sort((a, b) => {
    const diff = BigInt(a.moduleId) - BigInt(b.moduleId);
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return a.content.localeCompare(b.content);
  });

  // データ行をコンテンツでソート（決定的な順序にする）
  dataRows.sort((a, b) => a.content.localeCompare(b.content));

  // 全行の旧ID → 新ID マッピング
  // 0=ツリー行、1=react.fragment（予約）
  const idMap = new Map();
  let nextId = 2;

  // モジュール行のID割り当て
  for (const mrow of moduleRows) {
    const newId = nextId.toString(16);
    mrow.newId = newId;
    if (mrow.id !== newId) {
      idMap.set(mrow.id, newId);
    }
    nextId++;
  }

  // データ行のID割り当て（モジュールIDの後から連番）
  for (const drow of dataRows) {
    const newId = nextId.toString(16);
    drow.newId = newId;
    if (drow.id !== newId) {
      idMap.set(drow.id, newId);
    }
    nextId++;
  }

  // === Step 2: プレースホルダ方式で全参照を一括置換 ===

  const PLACEHOLDER_PREFIX = "\x00__RSC_ID_";
  const replaceRefs = (content) => {
    let result = content;
    // Pass 1: 旧ID → プレースホルダ
    for (const [oldId] of idMap) {
      const ph = `${PLACEHOLDER_PREFIX}${oldId}\x00`;
      result = result.replaceAll(`"$L${oldId}"`, `"$L${ph}"`);
      result = result.replaceAll(`"$${oldId}"`, `"$${ph}"`);
      result = result.replaceAll(`\\\"$L${oldId}\\\"`, `\\\"$L${ph}\\\"`);
      result = result.replaceAll(`\\\"$${oldId}\\\"`, `\\\"$${ph}\\\"`);
    }
    // Pass 2: プレースホルダ → 新ID
    for (const [oldId, newId] of idMap) {
      const ph = `${PLACEHOLDER_PREFIX}${oldId}\x00`;
      result = result.replaceAll(ph, newId);
    }
    return result;
  };

  // 全コンテンツの参照を置換
  for (const mrow of moduleRows) {
    mrow.content = replaceRefs(mrow.content);
  }
  for (const drow of dataRows) {
    drow.content = replaceRefs(drow.content);
  }
  if (treeRow) {
    treeRow.content = replaceRefs(treeRow.content);
  }

  // === Step 2.5: モジュール定義のチャンクリスト正規化 ===
  // 同一モジュールを持つ互換レイアウトチャンクが複数ある場合、
  // 常にアルファベット順で最初のものに統一する
  if (chunkEquivalenceMap) {
    for (const mrow of moduleRows) {
      for (const [from, to] of chunkEquivalenceMap) {
        mrow.content = mrow.content.replaceAll(from, to);
      }
    }
    if (treeRow) {
      for (const [from, to] of chunkEquivalenceMap) {
        treeRow.content = treeRow.content.replaceAll(from, to);
      }
    }
    for (const drow of dataRows) {
      for (const [from, to] of chunkEquivalenceMap) {
        drow.content = drow.content.replaceAll(from, to);
      }
    }
  }

  // === Step 3: データ行をツリー行にインライン化 ===

  if (treeRow) {
    const dataMap = new Map();
    for (const drow of dataRows) {
      dataMap.set(drow.newId, drow.content);
    }
    treeRow.content = inlineDataRows(treeRow.content, dataMap);

    // インライン化されなかったデータ行のみ残す
    const remaining = [];
    for (const drow of dataRows) {
      if (dataMap.has(drow.newId)) {
        remaining.push(drow);
      }
    }
    dataRows.length = 0;
    dataRows.push(...remaining);
  }

  // === Step 4: 出力を組み立て ===
  // 行内容から改行を除去（RSCは改行で行を区切るため、行内容に改行があると壊れる）
  const stripNewlines = (s) => s.replace(/\n/g, "");

  const output = [];

  if (hasFragmentRow) {
    output.push(`1:"$Sreact.fragment"`);
  }

  for (const mrow of moduleRows) {
    output.push(`${mrow.newId}:${stripNewlines(mrow.content)}`);
  }

  // ヒント行をソートし、CSSプリロードヒントは除去（レイアウト非決定性の影響を受けるため）
  // CSSは<link>タグで読み込まれるため、HL[]ヒントの除去は機能に影響しない
  const filteredHints = hintRows
    .filter((hint) => {
      // CSSプリロードヒントを除去
      if (/static\/css\//.test(hint)) return false;
      // 存在しないファイルへの参照も除去
      if (existingCssFiles) {
        const cssMatch = hint.match(/static\/css\/([0-9a-f]+\.css)/);
        if (cssMatch && !existingCssFiles.has(cssMatch[1])) return false;
      }
      return true;
    })
    .sort();
  for (const hint of filteredHints) {
    output.push(stripNewlines(hint));
  }

  if (treeRow) {
    // MetadataBoundary の行IDを特定し、ツリー行内の
    // ランダムなメタデータキー(21文字)を安定した値に置換する。
    // stabilize-build.js と同等の処理だが、RSC正規化後のIDで実行する。
    const metadataModuleRow = moduleRows.find((r) => r.content.includes('"MetadataBoundary"'));
    if (metadataModuleRow) {
      const mid = metadataModuleRow.newId;
      const keyPattern = new RegExp(
        `("\\$1",")[A-Za-z0-9_-]{21}(",\\{"children":\\[\\["\\$","\\$L${mid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}")`,
        "g",
      );
      treeRow.content = treeRow.content.replace(keyPattern, "$1__stable_metadata_key__$2");
    }
    output.push(`0:${stripNewlines(treeRow.content)}`);
  }

  for (const drow of dataRows) {
    output.push(`${drow.newId}:${stripNewlines(drow.content)}`);
  }

  return output.join("\n") + "\n";
};

// ============================================================
// 4. HTML 内の RSC ペイロードと script タグを正規化
// ============================================================

/**
 * HTML内のself.__next_f.push()からRSCペイロードを抽出し、正規化して書き戻す
 */
const stabilizeHtmlRsc = (html, chunkEquivalenceMap, existingCssFiles) => {
  // RSCペイロードを抽出
  const pushPattern = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  const pushes = [];
  let match;
  while ((match = pushPattern.exec(html)) !== null) {
    pushes.push(match[1]);
  }

  if (pushes.length === 0) return html;

  // 全push内容を結合してRSC行に分解
  // JSON.parseで正確にアンエスケープ
  // push call は行の途中で分割されることがあるため、
  // 改行ではなく空文字で結合する（各push callの末尾に既に\nがある）
  const combinedEscaped = pushes.join("");
  const combined = JSON.parse(`"${combinedEscaped}"`);

  const stabilized = stabilizeRscPayload(combined, chunkEquivalenceMap, existingCssFiles);

  // JSON.stringifyで正確にエスケープし直す
  const escaped = JSON.stringify(stabilized).slice(1, -1);

  // 1つのpushコールにまとめる
  const newPush = `self.__next_f.push([1,"${escaped}"])`;

  // 既存のpushコールをすべて含むscriptタグを見つけて置換
  // 最初のpushを新しい内容に置換し、残りを削除
  let result = html;
  let firstReplaced = false;

  result = result.replace(
    /<script>self\.__next_f\.push\(\[1,"(?:[^"\\]|\\.)*"\]\)<\/script>/g,
    (match) => {
      if (!firstReplaced) {
        firstReplaced = true;
        return `<script>${newPush}</script>`;
      }
      return ""; // 後続のpush scriptタグは削除
    },
  );

  return result;
};

/**
 * HTML内のscriptタグ順序を正規化
 */
const stabilizeScriptOrder = (html, chunkEquivalenceMap) => {
  let result = html;

  // 互換チャンクのscript参照を正規化
  // チャンク等価マップはペア形式 ("chunkId","static/chunks/path") だが、
  // HTML scriptタグは /app/_next/static/chunks/path 形式なのでパスのみ抽出して置換
  if (chunkEquivalenceMap) {
    for (const [from, to] of chunkEquivalenceMap) {
      // ペアからパスを抽出: "chunkId","static/chunks/xxx" → xxx
      const fromPath = from.match(/"static\/chunks\/([^"]+)"/)?.[1];
      const toPath = to.match(/"static\/chunks\/([^"]+)"/)?.[1];
      if (fromPath && toPath) {
        result = result.replaceAll(fromPath, toPath);
      }
    }
  }

  // CSSプリロード<link>タグを除去（レイアウト非決定性の影響を受けるため）
  // CSSは<link rel="stylesheet">で確実に読み込まれるのでプリロード除去は安全
  result = result.replace(/<link rel="preload" href="[^"]*\.css" as="style"\/>/g, "");

  // <head>内のscriptタグを抽出してソート
  const headMatch = result.match(/(<head[^>]*>)([\s\S]*?)(<\/head>)/);
  if (!headMatch) return result;

  const headContent = headMatch[2];

  // scriptタグ(async)を抽出
  const asyncScripts = [];
  const headWithoutScripts = headContent.replace(
    /<script src="[^"]*" async=""><\/script>/g,
    (match) => {
      asyncScripts.push(match);
      return "___SCRIPT_PLACEHOLDER___";
    },
  );

  // src属性でソート
  asyncScripts.sort((a, b) => {
    const srcA = a.match(/src="([^"]*)"/)?.[1] || "";
    const srcB = b.match(/src="([^"]*)"/)?.[1] || "";
    return srcA.localeCompare(srcB);
  });

  // 重複を除去（互換チャンク正規化で同じscriptが複数になる場合）
  const uniqueScripts = [...new Set(asyncScripts)];

  // プレースホルダーをソート済みスクリプトで置換
  let scriptIdx = 0;
  const newHeadContent = headWithoutScripts.replace(
    /___SCRIPT_PLACEHOLDER___/g,
    () => {
      if (scriptIdx < uniqueScripts.length) {
        return uniqueScripts[scriptIdx++];
      }
      return ""; // 重複分のプレースホルダーを除去
    },
  );

  return result.replace(
    /(<head[^>]*>)([\s\S]*?)(<\/head>)/,
    `${headMatch[1]}${newHeadContent}${headMatch[3]}`,
  );
};

// ============================================================
// 5. ファイル処理 + リネーム
// ============================================================

const renameMap = new Map();

const processChunksDir = () => {
  const chunksDir = path.join(NEXT_STATIC_DIR, "chunks");
  if (!fs.existsSync(chunksDir)) return;

  const files = fs.readdirSync(chunksDir);
  for (const file of files) {
    if (!file.startsWith("webpack-") || !file.endsWith(".js") || file.endsWith(".js.map"))
      continue;

    const filePath = path.join(chunksDir, file);
    const original = fs.readFileSync(filePath, "utf-8");
    const stabilized = stabilizeWebpackRuntime(original);

    if (stabilized !== original) {
      fs.writeFileSync(filePath, stabilized, "utf-8");
    }

    const newHash = computeHash(stabilized);
    const newName = `webpack-${newHash}.js`;

    if (newName !== file) {
      fs.renameSync(filePath, path.join(chunksDir, newName));
      renameMap.set(file, newName);

      const mapFile = file + ".map";
      const mapPath = path.join(chunksDir, mapFile);
      if (fs.existsSync(mapPath)) {
        const newMapName = newName + ".map";
        fs.renameSync(mapPath, path.join(chunksDir, newMapName));
        renameMap.set(mapFile, newMapName);
      }
    }
  }
};

const processCssDir = () => {
  const cssDir = path.join(NEXT_STATIC_DIR, "css");
  if (!fs.existsSync(cssDir)) return;

  const files = fs.readdirSync(cssDir);
  for (const file of files) {
    if (!file.endsWith(".css") || file.endsWith(".css.map")) continue;

    const filePath = path.join(cssDir, file);
    const original = fs.readFileSync(filePath, "utf-8");
    const stabilized = stabilizeCss(original);

    if (stabilized !== original) {
      fs.writeFileSync(filePath, stabilized, "utf-8");
    }

    const newHash = computeHash(stabilized);
    const newName = `${newHash}.css`;

    if (newName !== file) {
      fs.renameSync(filePath, path.join(cssDir, newName));
      renameMap.set(file, newName);

      const mapFile = file + ".map";
      const mapPath = path.join(cssDir, mapFile);
      if (fs.existsSync(mapPath)) {
        const newMapName = newName + ".map";
        fs.renameSync(mapPath, path.join(cssDir, newMapName));
        renameMap.set(mapFile, newMapName);
      }
    }
  }
};

/**
 * ソースマップを削除する（正規化が困難なため）
 */
const removeSourceMaps = () => {
  const removeFromDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        removeFromDir(fullPath);
      } else if (entry.name.endsWith(".map")) {
        fs.unlinkSync(fullPath);
      }
    }
  };
  removeFromDir(path.join(NEXT_STATIC_DIR, "css"));
  // webpack の .map も削除
  const chunksDir = path.join(NEXT_STATIC_DIR, "chunks");
  if (fs.existsSync(chunksDir)) {
    for (const file of fs.readdirSync(chunksDir)) {
      if (file.startsWith("webpack-") && file.endsWith(".js.map")) {
        fs.unlinkSync(path.join(chunksDir, file));
      }
    }
  }
};

/**
 * txt/html ファイルのRSCペイロードを正規化し、リネーム参照も更新する
 */
const processContentFiles = (dir, chunkEquivMap, existingCssFiles) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      processContentFiles(fullPath, chunkEquivMap, existingCssFiles);
      continue;
    }

    if (!/\.(html|js|txt)$/.test(entry.name)) continue;

    let content = fs.readFileSync(fullPath, "utf-8");
    let changed = false;

    // リネーム参照更新（CSS/JS/webpackファイルの旧名→新名）
    for (const [oldName, newName] of renameMap) {
      if (content.includes(oldName)) {
        content = content.replaceAll(oldName, newName);
        changed = true;
      }
    }

    // RSCペイロード正規化（txt/htmlのみ）
    if (entry.name.endsWith(".txt")) {
      const stabilized = stabilizeRscPayload(content, chunkEquivMap, existingCssFiles);
      if (stabilized !== content) {
        content = stabilized;
        changed = true;
      }
    } else if (entry.name.endsWith(".html")) {
      let stabilized = stabilizeHtmlRsc(content, chunkEquivMap, existingCssFiles);
      stabilized = stabilizeScriptOrder(stabilized, chunkEquivMap);
      if (stabilized !== content) {
        content = stabilized;
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(fullPath, content, "utf-8");
    }
  }
};

/**
 * リネームされたファイルへの参照を更新する
 */
const updateReferences = (dir) => {
  if (renameMap.size === 0) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      updateReferences(fullPath);
      continue;
    }

    if (!/\.(html|js|txt)$/.test(entry.name)) continue;

    let content = fs.readFileSync(fullPath, "utf-8");
    let changed = false;

    for (const [oldName, newName] of renameMap) {
      if (content.includes(oldName)) {
        content = content.replaceAll(oldName, newName);
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(fullPath, content, "utf-8");
    }
  }
};

// ============================================================
// 実行
// ============================================================

// Step 1: webpack runtime, CSS の正規化 + リネーム
processChunksDir();
processCssDir();

// Step 2: 非決定的ソースマップを削除
removeSourceMaps();

// Step 3: 互換チャンクマップ構築
const chunkEquivMap = buildChunkEquivalenceMap();
if (chunkEquivMap) {
  console.log(`stabilize-chunk-order: ${chunkEquivMap.size} equivalent chunk(s) found.`);
  for (const [from, to] of chunkEquivMap) {
    console.log(`  ${from} -> ${to}`);
  }
}

// Step 4: 存在するCSSファイルのセットを構築（ヒント行フィルタ用）
const cssDir = path.join(NEXT_STATIC_DIR, "css");
const existingCssFiles = new Set();
if (fs.existsSync(cssDir)) {
  for (const f of fs.readdirSync(cssDir)) {
    if (f.endsWith(".css") && !f.endsWith(".css.map")) {
      existingCssFiles.add(f);
    }
  }
}

// Step 5: リネーム参照更新 + RSCペイロード正規化（1パスで処理）
processContentFiles(OUTPUT_DIR, chunkEquivMap, existingCssFiles);

// Step 6: 最終パス - 残存するCSS HLヒントとCSSプリロードを確実に除去
const finalCleanCssHints = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      finalCleanCssHints(fullPath);
      continue;
    }
    if (!entry.name.endsWith(".html")) continue;

    let content = fs.readFileSync(fullPath, "utf-8");
    // RSCプッシュコール内のCSS HLヒントを除去 (エスケープ形式)
    const before = content;
    content = content.replace(/\\n:HL\[\\"\/app\/_next\/static\/css\/[^"]*\\",\\"style\\"\]/g, "");
    // link preload CSS (二重チェック)
    content = content.replace(/<link rel="preload" href="[^"]*\.css" as="style"\/>/g, "");
    if (content !== before) {
      fs.writeFileSync(fullPath, content, "utf-8");
    }
  }
};
finalCleanCssHints(OUTPUT_DIR);

console.log(`stabilize-chunk-order: ${renameMap.size} files renamed.`);
console.log("stabilize-chunk-order: RSC payload stabilized.");
