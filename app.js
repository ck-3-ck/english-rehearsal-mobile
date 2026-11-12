"use strict";

const byId = id => document.getElementById(id);
const localKeys = {
  manuscript: "rehearsal.manuscript",
  settings: "rehearsal.settings",
  translationPrefix: "rehearsal.translation.en-zh-CN:"
};
const defaultTerms = "FPGA = F P G A\nDDR4 = D D R four\nNVMe = N V M E";
const sample = "Good morning, everyone. Today I’ll explain how an FPGA processes data. Let’s look at the next slide.";
const wordPattern = /\p{N}+(?:[.,]\p{N}+)+|[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’‐‑-][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;
const state = {
  script: "", sentences: [], current: 0, tokens: [], rangeMode: false,
  rangeStart: null, rangeEnd: null, ipaRequest: 0, playback: null, voices: []
};
const speech = window.speechSynthesis;
const canSpeak = Boolean(speech && window.SpeechSynthesisUtterance);
const phoneLayout = matchMedia("(max-width: 730px)");
const outline = byId("outline");
const dialog = byId("importDialog");
const controls = {
  position: byId("position"), sentence: byId("sentence"), range: byId("rangeMode"),
  pronunciation: byId("pronunciation"), tip: byId("tip"), status: byId("status"),
  play: byId("play"), stop: byId("stop"), previous: byId("previous"), next: byId("next"),
  voice: byId("voice"), repeat: byId("repeat"), delay: byId("delay")
};

function loadLocal(key) {
  try { return JSON.parse(localStorage.getItem(key)); }
  catch { return null; }
}

function saveLocal(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The current session remains usable if browser storage is unavailable.
  }
}

function splitSentences(text) {
  const abbreviations = /\b(?:Mr|Mrs|Ms|Dr|Prof|Fig|Figs|Eq|Eqs|Sec|Ch|vs|approx|e\.g|i\.e)\.$/i;
  const initials = /(?:^|\s)(?:[A-Z]\.)+$/;
  const sentences = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n+/)) {
    const paragraph = raw.replace(/\s+/g, " ").trim();
    let start = 0;
    for (const mark of paragraph.matchAll(/[.!?]+["”’')\]]*(?=\s|$)/g)) {
      const end = mark.index + mark[0].length;
      const sentence = paragraph.slice(start, end).trim();
      if (end < paragraph.length && mark[0] === "." &&
          (abbreviations.test(sentence) || initials.test(sentence))) continue;
      if (sentence) sentences.push(sentence);
      start = end;
    }
    const remaining = paragraph.slice(start).trim();
    if (remaining) sentences.push(remaining);
  }
  return sentences;
}

function normalize(word) {
  return word.replace(/[‘’]/g, "'").replace(/[‐‑]/g, "-").toLowerCase();
}

function parseTerms(text) {
  const terms = new Map();
  text.split(/\r\n?|\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const equals = line.indexOf("=");
    const term = line.slice(0, equals).trim();
    const alias = line.slice(equals + 1).trim();
    if (equals < 1 || !term || !alias) throw new Error("第 " + (index + 1) + " 行应写成「术语 = 读法」。");
    terms.set(normalize(term), alias);
  });
  return terms;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}

function spokenText(text) {
  if (!state.terms.size) return text;
  const keys = [...state.terms.keys()].sort((a, b) => b.length - a.length);
  const match = new RegExp("(^|[^\\p{L}\\p{N}_])(" + keys.map(escapeRegex).join("|") + ")(?![\\p{L}\\p{N}_])", "giu");
  return text.replace(/[‘’]/g, "'").replace(/[‐‑]/g, "-")
    .replace(match, (_, prefix, word) => prefix + state.terms.get(normalize(word)));
}

let dictionaryPromise;
function loadDictionary() {
  if (!dictionaryPromise) {
    dictionaryPromise = fetch("ipa-en-us.txt")
      .then(response => {
        if (!response.ok) throw new Error("IPA " + response.status);
        return response.text();
      })
      .then(text => {
        const entries = new Map();
        for (const line of text.split("\n")) {
          const tab = line.indexOf("\t");
          if (tab > 0) entries.set(normalize(line.slice(0, tab)), line.slice(tab + 1).trim());
        }
        return entries;
      })
      .catch(error => {
        dictionaryPromise = null;
        throw error;
      });
  }
  return dictionaryPromise;
}

function findIpa(dictionary, word) {
  const key = normalize(word);
  const alias = state.terms.get(key);
  if (!alias && dictionary.has(key)) return dictionary.get(key);
  const parts = alias ? alias.split(/\s+/) : key.split("-");
  if (!alias && parts.length < 2) return null;
  const readings = parts.map(part => {
    const lookup = alias && /^[A-Z]$/.test(part) ? part.toLowerCase() + "." : normalize(part);
    return dictionary.get(lookup)?.split(", ")[0];
  });
  return readings.every(Boolean) ? readings.join("  ") : null;
}

function hideIpa() {
  state.ipaRequest += 1;
  controls.pronunciation.hidden = true;
}

function showIpa(word) {
  const request = ++state.ipaRequest;
  controls.pronunciation.hidden = false;
  byId("ipaWord").textContent = word + " · 美式 IPA";
  byId("ipaText").textContent = "查找音标…";
  loadDictionary().then(dictionary => {
    if (request !== state.ipaRequest) return;
    byId("ipaText").textContent = findIpa(dictionary, word) || "词表未收录此词的音标";
  }).catch(() => {
    if (request === state.ipaRequest) byId("ipaText").textContent = "词表暂未加载成功，请再点一次。";
  });
}

function updateVoices() {
  if (!canSpeak) return;
  state.voices = speech.getVoices().filter(voice => /^en(?:-|$)/i.test(voice.lang))
    .sort((a, b) => Number(b.localService) - Number(a.localService) ||
      Number(b.lang.toLowerCase() === "en-us") - Number(a.lang.toLowerCase() === "en-us") ||
      a.name.localeCompare(b.name));
  controls.voice.replaceChildren(new Option("自动选择英语音色", ""));
  for (const voice of state.voices) {
    const location = voice.localService ? "本机" : "联网";
    controls.voice.add(new Option(voice.name + " · " + voice.lang + " · " + location, voice.voiceURI));
  }
  controls.voice.value = state.voices.some(voice => voice.voiceURI === settings.voice) ? settings.voice : "";
}

function stopSpeech(message = "准备就绪") {
  const playback = state.playback;
  state.playback = null;
  if (playback) clearTimeout(playback.timer);
  if (canSpeak && (playback || speech.speaking || speech.pending)) speech.cancel();
  controls.stop.disabled = true;
  controls.status.textContent = message;
}

function speak(playback, again) {
  const utterance = new SpeechSynthesisUtterance(playback.text);
  playback.utterance = utterance;
  utterance.lang = playback.voice?.lang || "en-US";
  if (playback.voice) utterance.voice = playback.voice;
  utterance.rate = playback.rate;
  controls.status.textContent = again ? "正在示范第二遍…" :
    (playback.word ? "正在读单词 · " + playback.word : "正在朗读…");
  controls.stop.disabled = false;
  utterance.onend = () => {
    if (state.playback !== playback) return;
    if (playback.repeat && !again) {
      controls.status.textContent = "轮到你跟读 · " + playback.delay + " 秒后再示范";
      playback.timer = setTimeout(() => {
        if (state.playback === playback) speak(playback, true);
      }, playback.delay * 1000);
    } else {
      state.playback = null;
      controls.stop.disabled = true;
      controls.status.textContent = playback.word ? "已读单词 · " + playback.word : "播放完毕";
    }
  };
  utterance.onerror = event => {
    if (state.playback !== playback) return;
    const message = event.error === "not-allowed" ? "请点「听整句」开始播放。" :
      "语音暂不可用。可在「音色、复读和术语」中换一个英语音色。";
    stopSpeech(message);
  };
  try { speech.speak(utterance); }
  catch { stopSpeech("语音暂不可用，请重试。"); }
}

function playText(text, word = "") {
  if (!text) return;
  if (!canSpeak) {
    stopSpeech("当前浏览器无法朗读。请在 iPhone 的 Safari 中打开。");
    return;
  }
  stopSpeech();
  if (!state.voices.length) updateVoices();
  const voice = state.voices.find(item => item.voiceURI === controls.voice.value) ||
    state.voices.find(item => item.localService) || null;
  const playback = {
    text: spokenText(text), word, voice, rate: Number(settings.rate),
    repeat: !word && settings.repeat, delay: Number(settings.delay), timer: null
  };
  state.playback = playback;
  speak(playback, false);
}

function selectionRange() {
  if (state.rangeStart === null || state.rangeEnd === null) return null;
  return [Math.min(state.rangeStart, state.rangeEnd), Math.max(state.rangeStart, state.rangeEnd)];
}

function refreshRange() {
  const range = selectionRange();
  state.tokens.forEach((token, index) => {
    const selected = range ? index >= range[0] && index <= range[1] : index === state.rangeStart;
    token.button.classList.toggle("is-selected", selected);
  });
  controls.range.setAttribute("aria-pressed", String(state.rangeMode));
  controls.range.textContent = state.rangeMode ? "结束选段" : "选段";
  controls.tip.textContent = state.rangeMode ?
    (range ? "可播放选段，或点单词重新选择" : (state.rangeStart === null ? "轻点起始单词" : "再轻点结束单词")) :
    "轻点单词可听发音、看音标";
  byId("playLabel").textContent = range ? "听选段" : "听整句";
}

function handleWord(index) {
  if (!state.rangeMode) {
    state.tokens.forEach((token, i) => token.button.classList.toggle("is-selected", i === index));
    const word = state.tokens[index].word;
    playText(word, word);
    showIpa(word);
    return;
  }
  stopSpeech();
  if (state.rangeStart === null || state.rangeEnd !== null) {
    state.rangeStart = index;
    state.rangeEnd = null;
  } else {
    state.rangeEnd = index;
  }
  refreshRange();
}

const translateButton = byId("translate");
const translationActions = byId("translationActions");
const translationText = byId("translationText");
const translations = new Map();
let translationRequest = null;

function savedTranslation(sentence) {
  const translation = translations.get(sentence) ?? loadLocal(localKeys.translationPrefix + sentence);
  return typeof translation === "string" ? translation : "";
}

function renderTranslation(translation) {
  translationActions.hidden = Boolean(translation);
  translationText.textContent = translation;
  translationText.hidden = !translation;
  translateButton.setAttribute("aria-expanded", String(Boolean(translation)));
}

function resetTranslation(sentence) {
  translationRequest?.abort();
  translationRequest = null;
  translateButton.disabled = !sentence;
  translateButton.textContent = "看译文";
  renderTranslation(sentence ? savedTranslation(sentence) : "");
}

function translationChunks(sentence) {
  const encoder = new TextEncoder();
  const limit = 500;
  if (encoder.encode(sentence).length <= limit) return [sentence];

  const chunks = [];
  let start = 0;
  let end = 0;
  let bytes = 0;
  let boundary = 0;
  while (end < sentence.length) {
    const character = String.fromCodePoint(sentence.codePointAt(end));
    const size = encoder.encode(character).length;
    if (bytes + size > limit) {
      const cut = boundary > start ? boundary : end;
      chunks.push(sentence.slice(start, cut).trim());
      start = end = cut;
      bytes = 0;
      continue;
    }
    end += character.length;
    bytes += size;
    if (/\s/u.test(character)) boundary = end;
  }
  chunks.push(sentence.slice(start).trim());
  return chunks.filter(Boolean);
}

async function fetchTranslation(sentence, signal) {
  const results = [];
  for (const chunk of translationChunks(sentence)) {
    const url = new URL("https://api.mymemory.translated.net/get");
    url.searchParams.set("q", chunk);
    url.searchParams.set("langpair", "en|zh-CN");
    const response = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    const data = await response.json();
    const translation = data.responseData?.translatedText?.trim();
    if (response.status === 429 || Number(data.responseStatus) === 429) {
      throw new Error("今日翻译额度已用完，请明天再试。");
    }
    if (!response.ok || Number(data.responseStatus) !== 200 || !translation) {
      throw new Error("翻译服务暂时不可用，请重试。");
    }
    results.push(translation);
  }
  return results.join(" ");
}

async function showTranslation() {
  const sentence = state.sentences[state.current];
  if (!sentence || translationRequest) return;

  const cached = savedTranslation(sentence);
  if (cached) {
    renderTranslation(cached);
    return;
  }

  translationText.hidden = false;
  translateButton.setAttribute("aria-expanded", "true");

  const request = new AbortController();
  translationRequest = request;
  translateButton.disabled = true;
  translationText.textContent = "正在翻译…";
  const timeout = setTimeout(() => request.abort(), 15000);
  try {
    const translation = await fetchTranslation(sentence, request.signal);
    if (translationRequest !== request) return;
    translations.set(sentence, translation);
    saveLocal(localKeys.translationPrefix + sentence, translation);
    renderTranslation(translation);
  } catch (error) {
    if (translationRequest !== request) return;
    translationText.textContent = request.signal.aborted ? "翻译超时，请重试。" :
      (error.message.startsWith("今日翻译额度") ? error.message : "暂时无法翻译，请检查网络后重试。");
    translateButton.textContent = "重试翻译";
  } finally {
    clearTimeout(timeout);
    if (translationRequest === request) {
      translationRequest = null;
      translateButton.disabled = false;
    }
  }
}

function renderSentence() {
  const sentence = state.sentences[state.current] || "";
  hideIpa();
  resetTranslation(sentence);
  state.rangeMode = false;
  state.rangeStart = null;
  state.rangeEnd = null;
  state.tokens = [];
  const fragment = document.createDocumentFragment();
  let end = 0;
  for (const match of sentence.matchAll(wordPattern)) {
    const word = match[0];
    if (match.index > end) fragment.append(sentence.slice(end, match.index));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "word";
    button.textContent = word;
    const index = state.tokens.length;
    end = match.index + word.length;
    state.tokens.push({ word, start: match.index, end, button });
    button.addEventListener("click", () => handleWord(index));
    fragment.append(button);
  }
  fragment.append(sentence.slice(end));
  controls.sentence.replaceChildren(fragment);
  controls.position.textContent = sentence ? "第 " + (state.current + 1) + " / " + state.sentences.length + " 句" : "等待讲稿";
  controls.play.disabled = !sentence;
  controls.range.disabled = !state.tokens.length;
  controls.previous.disabled = state.current === 0;
  controls.next.disabled = state.current + 1 >= state.sentences.length;
  refreshRange();
}

function renderList() {
  const query = byId("search").value.trim().toLowerCase();
  const fragment = document.createDocumentFragment();
  state.sentences.forEach((sentence, index) => {
    if (query && !sentence.toLowerCase().includes(query)) return;
    const item = document.createElement("li");
    const button = document.createElement("button");
    const number = document.createElement("span");
    const label = document.createElement("span");
    number.className = "ordinal";
    number.textContent = String(index + 1).padStart(2, "0");
    label.className = "sentence-title";
    label.lang = "en";
    label.textContent = sentence;
    button.type = "button";
    button.dataset.index = String(index);
    if (index === state.current) button.setAttribute("aria-current", "true");
    button.append(number, label);
    item.append(button);
    fragment.append(item);
  });
  if (!fragment.childElementCount) {
    const empty = document.createElement("li");
    empty.className = "empty-result";
    empty.textContent = query ? "没有匹配的句子" : "暂无讲稿";
    fragment.append(empty);
  }
  byId("sentenceList").replaceChildren(fragment);
}

function playCurrent() {
  const sentence = state.sentences[state.current] || "";
  const range = selectionRange();
  playText(range ? sentence.slice(state.tokens[range[0]].start, state.tokens[range[1]].end) : sentence);
}

function selectSentence(index) {
  if (!state.sentences[index]) return;
  stopSpeech();
  state.current = index;
  renderSentence();
  const previous = byId("sentenceList").querySelector('[aria-current="true"]');
  if (previous) previous.removeAttribute("aria-current");
  const active = byId("sentenceList").querySelector('[data-index="' + index + '"]');
  if (active) active.setAttribute("aria-current", "true");
  playCurrent();
}

function setScript(text, name) {
  const sentences = splitSentences(text);
  if (!sentences.length) return false;
  stopSpeech();
  state.script = text;
  state.sentences = sentences;
  state.current = 0;
  byId("scriptInfo").textContent = name + " · " + sentences.length + " 句";
  byId("search").value = "";
  renderSentence();
  renderList();
  return true;
}

let defaultPromise;
function fetchDefault() {
  if (!defaultPromise) {
    defaultPromise = fetch("sample.txt").then(response => {
      if (!response.ok) throw new Error("讲稿加载失败");
      return response.text();
    }).catch(error => {
      defaultPromise = null;
      throw error;
    });
  }
  return defaultPromise;
}

const settings = {
  rate: "1", repeat: false, delay: "3", voice: "", terms: defaultTerms,
  ...loadLocal(localKeys.settings)
};
try { state.terms = parseTerms(settings.terms); }
catch { settings.terms = defaultTerms; state.terms = parseTerms(defaultTerms); }
byId("terms").value = settings.terms;
controls.repeat.checked = Boolean(settings.repeat);
controls.delay.value = settings.delay;
controls.delay.disabled = !controls.repeat.checked;
for (const radio of document.querySelectorAll('[name="speed"]')) {
  if (radio.value === settings.rate) radio.checked = true;
  radio.addEventListener("change", () => {
    settings.rate = radio.value;
    saveLocal(localKeys.settings, settings);
  });
}
for (const control of [controls.repeat, controls.delay, controls.voice]) {
  control.addEventListener("change", () => {
    settings.repeat = controls.repeat.checked;
    settings.delay = controls.delay.value;
    settings.voice = controls.voice.value;
    controls.delay.disabled = !settings.repeat;
    saveLocal(localKeys.settings, settings);
  });
}
byId("saveTerms").addEventListener("click", () => {
  try {
    const text = byId("terms").value;
    state.terms = parseTerms(text);
    settings.terms = text;
    hideIpa();
    saveLocal(localKeys.settings, settings);
    byId("termsStatus").textContent = "已保存";
  } catch (error) { byId("termsStatus").textContent = error.message; }
});

outline.open = !phoneLayout.matches;
updateVoices();
if (canSpeak) speech.addEventListener("voiceschanged", updateVoices);
controls.play.addEventListener("click", playCurrent);
translateButton.addEventListener("click", showTranslation);
controls.stop.addEventListener("click", () => stopSpeech("已停止"));
controls.previous.addEventListener("click", () => selectSentence(state.current - 1));
controls.next.addEventListener("click", () => selectSentence(state.current + 1));
controls.range.addEventListener("click", () => {
  state.rangeMode = !state.rangeMode;
  state.rangeStart = null;
  state.rangeEnd = null;
  hideIpa();
  refreshRange();
});
byId("search").addEventListener("input", renderList);
byId("sentenceList").addEventListener("click", event => {
  const target = event.target.closest("button[data-index]");
  if (!target) return;
  selectSentence(Number(target.dataset.index));
  if (phoneLayout.matches) {
    outline.open = false;
    controls.position.scrollIntoView({ block: "start" });
  }
});

const scriptInput = byId("scriptInput");
const fileInput = byId("scriptFile");
const importStatus = byId("importStatus");
let fileName = "";
let defaultText = null;
byId("openImport").addEventListener("click", () => {
  stopSpeech();
  scriptInput.value = state.script;
  fileInput.value = "";
  fileName = "";
  defaultText = null;
  importStatus.textContent = "";
  dialog.showModal();
});
byId("cancelImport").addEventListener("click", () => dialog.close());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  try {
    const bytes = await file.arrayBuffer();
    const view = new Uint8Array(bytes);
    let encoding = "utf-8";
    if (view[0] === 255 && view[1] === 254) encoding = "utf-16le";
    if (view[0] === 254 && view[1] === 255) encoding = "utf-16be";
    scriptInput.value = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    fileName = file.name;
    defaultText = null;
    importStatus.textContent = file.name + " 已载入";
  } catch { importStatus.textContent = "无法读取文件，请用 UTF-8 保存 TXT 或直接粘贴。"; }
});
byId("resetScript").addEventListener("click", async () => {
  try {
    defaultText = (await fetchDefault()).replace(/\r\n?/g, "\n");
    scriptInput.value = defaultText;
    fileName = "";
    importStatus.textContent = "示例稿已载入";
  } catch { importStatus.textContent = "示例稿暂未加载，请稍后再试。"; }
});
byId("importForm").addEventListener("submit", event => {
  event.preventDefault();
  const text = scriptInput.value;
  const useDefault = defaultText !== null && text === defaultText;
  const name = useDefault ? "示例稿" : fileName || "我的讲稿";
  if (!setScript(text, name)) {
    importStatus.textContent = "请先填入讲稿。";
    return;
  }
  saveLocal(localKeys.manuscript, useDefault ? null : { text, name });
  dialog.close();
});

const saved = loadLocal(localKeys.manuscript);
if (typeof saved?.text !== "string" || !setScript(saved.text, saved.name || "我的讲稿")) {
  fetchDefault().then(text => {
    if (!state.script && !setScript(text, "示例稿")) throw new Error("示例稿为空");
  }).catch(() => {
    if (!state.script) {
      setScript(sample, "示例稿");
      controls.status.textContent = "示例稿暂未加载，可以点「换讲稿」重试。";
    }
  });
}
