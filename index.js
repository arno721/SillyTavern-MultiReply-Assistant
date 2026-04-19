import { extension_settings, renderExtensionTemplateAsync } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const MODULE_NAME = "SillyTavern-MultiReply-Assistant";
const TEMPLATE_ROOT = `third-party/${MODULE_NAME}`;
const PANEL_OVERLAY_ID = "stmr-overlay";
const PANEL_ID = "stmr-panel";
const OPEN_BUTTON_ID = "stmr-open-panel-button";
const DEFAULT_STYLE_LIST = [
    "自然顺口",
    "温柔体贴",
    "俏皮可爱",
    "高情商圆润",
    "直球主动",
    "简短利落",
    "暧昧拉扯",
    "成熟稳重",
];

const DEFAULT_SETTINGS = {
    enabled: true,
    replyCount: 4,
    responseLength: 120,
    lengthInstruction: "每条约 40-80 字，像真人聊天一样自然。",
    stylesText: DEFAULT_STYLE_LIST.join("\n"),
    extraInstructions: "",
    useInputDraft: true,
};

const state = {
    observer: null,
    isGenerating: false,
    stopAfterCurrent: false,
    generationToken: 0,
    ui: {
        overlay: null,
        panel: null,
        note: null,
        resultsList: null,
        progressBar: null,
        progressLabel: null,
        generateButton: null,
        stopButton: null,
        closeButton: null,
        form: {},
    },
};

function clampNumber(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
}

function getSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    const settings = extension_settings[MODULE_NAME];

    if (typeof settings.enabled !== "boolean") {
        settings.enabled = DEFAULT_SETTINGS.enabled;
    }
    settings.replyCount = clampNumber(settings.replyCount, 1, 12, DEFAULT_SETTINGS.replyCount);
    settings.responseLength = clampNumber(settings.responseLength, 16, 1000, DEFAULT_SETTINGS.responseLength);
    settings.lengthInstruction = String(settings.lengthInstruction ?? DEFAULT_SETTINGS.lengthInstruction);
    settings.stylesText = String(settings.stylesText ?? DEFAULT_SETTINGS.stylesText);
    settings.extraInstructions = String(settings.extraInstructions ?? DEFAULT_SETTINGS.extraInstructions);
    settings.useInputDraft = typeof settings.useInputDraft === "boolean"
        ? settings.useInputDraft
        : DEFAULT_SETTINGS.useInputDraft;

    return settings;
}

function commitSettings(partial = {}) {
    Object.assign(getSettings(), partial);
    saveSettingsDebounced();
}

function parseStyles(rawText) {
    const source = String(rawText ?? "")
        .split(/\r?\n|,|，|;|；/)
        .map((item) => item.trim())
        .filter(Boolean);

    const deduped = [...new Set(source)];
    return deduped.length > 0 ? deduped : [...DEFAULT_STYLE_LIST];
}

function buildStyleSequence(count, stylesText) {
    const primary = parseStyles(stylesText);
    const fallback = DEFAULT_STYLE_LIST.filter((item) => !primary.includes(item));
    const pool = [...primary, ...fallback];
    const output = [];

    for (let index = 0; index < count; index += 1) {
        const base = pool[index % pool.length] ?? `自由变体 ${index + 1}`;
        const round = Math.floor(index / pool.length);
        output.push(round === 0 ? base : `${base}（变体 ${round + 1}）`);
    }

    return output;
}

function getDraftText() {
    return String(document.querySelector("#send_textarea")?.value ?? "").trim();
}

function writeToInput(text, mode = "replace") {
    const textarea = document.querySelector("#send_textarea");
    if (!textarea) {
        toastr.warning("没有找到输入框。", "多候选帮答");
        return;
    }

    const normalized = String(text ?? "").trim();
    if (!normalized) {
        return;
    }

    const existing = String(textarea.value ?? "");
    if (mode === "append" && existing.trim()) {
        textarea.value = `${existing.trimEnd()}\n${normalized}`;
    } else {
        textarea.value = normalized;
    }

    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
}

async function copyToClipboard(text) {
    const normalized = String(text ?? "").trim();
    if (!normalized) {
        return;
    }

    try {
        await navigator.clipboard.writeText(normalized);
    } catch {
        const helper = document.createElement("textarea");
        helper.value = normalized;
        helper.setAttribute("readonly", "readonly");
        helper.style.position = "fixed";
        helper.style.opacity = "0";
        document.body.append(helper);
        helper.select();
        document.execCommand("copy");
        helper.remove();
    }

    toastr.success("已复制到剪贴板。", "多候选帮答");
}

function createButton() {
    const button = document.createElement("button");
    button.id = OPEN_BUTTON_ID;
    button.type = "button";
    button.className = "stmr-trigger-button";
    button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span>多候选帮答</span>';
    button.addEventListener("click", async () => {
        openPanel();
        await generateCandidates();
    });
    return button;
}

function ensureChatButton() {
    const textarea = document.querySelector("#send_textarea");
    const existingButton = document.getElementById(OPEN_BUTTON_ID);
    const settings = getSettings();

    if (!settings.enabled || !textarea) {
        existingButton?.closest(".stmr-button-row")?.remove();
        return;
    }

    if (existingButton) {
        return;
    }

    const row = document.createElement("div");
    row.className = "stmr-button-row";
    row.append(createButton());
    textarea.insertAdjacentElement("afterend", row);
}

function updateProgress(current, total) {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    state.ui.progressBar.style.width = `${percent}%`;
    state.ui.progressLabel.textContent = total > 0 ? `${current}/${total}` : "0/0";
}

function setPanelNote(text) {
    if (state.ui.note) {
        state.ui.note.textContent = text;
    }
}

function setGeneratingUi(isGenerating) {
    state.isGenerating = isGenerating;
    state.ui.generateButton.disabled = isGenerating;
    state.ui.stopButton.classList.toggle("stmr-stop-hidden", !isGenerating);
}

function syncPanelInputsFromSettings() {
    const settings = getSettings();
    const { form } = state.ui;

    if (!form.replyCount) {
        return;
    }

    form.replyCount.value = settings.replyCount;
    form.responseLength.value = settings.responseLength;
    form.lengthInstruction.value = settings.lengthInstruction;
    form.stylesText.value = settings.stylesText;
    form.extraInstructions.value = settings.extraInstructions;
    form.useInputDraft.checked = settings.useInputDraft;
}

function readPanelSettings() {
    const { form } = state.ui;
    const next = {
        replyCount: clampNumber(form.replyCount.value, 1, 12, DEFAULT_SETTINGS.replyCount),
        responseLength: clampNumber(form.responseLength.value, 16, 1000, DEFAULT_SETTINGS.responseLength),
        lengthInstruction: String(form.lengthInstruction.value ?? "").trim() || DEFAULT_SETTINGS.lengthInstruction,
        stylesText: String(form.stylesText.value ?? ""),
        extraInstructions: String(form.extraInstructions.value ?? "").trim(),
        useInputDraft: Boolean(form.useInputDraft.checked),
    };

    commitSettings(next);
    syncPanelInputsFromSettings();
    syncSettingsInputsFromState();
    return getSettings();
}

function syncSettingsInputsFromState() {
    const settings = getSettings();

    $("#stmr_settings_enabled").prop("checked", settings.enabled);
    $("#stmr_settings_reply_count").val(settings.replyCount);
    $("#stmr_settings_response_length").val(settings.responseLength);
    $("#stmr_settings_length_instruction").val(settings.lengthInstruction);
    $("#stmr_settings_styles_text").val(settings.stylesText);
    $("#stmr_settings_extra_instructions").val(settings.extraInstructions);
    $("#stmr_settings_use_input_draft").prop("checked", settings.useInputDraft);
}

function clearResults(message = "点“开始生成”后，这里会出现多条不同风格的候选回复。") {
    state.ui.resultsList.replaceChildren();

    const empty = document.createElement("div");
    empty.className = "stmr-empty-state";
    empty.textContent = message;
    state.ui.resultsList.append(empty);
    updateProgress(0, 0);
}

function createActionButton(label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu_button";
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
}

function appendCandidateCard(candidate, index, total) {
    const card = document.createElement("article");
    card.className = "stmr-result-card";

    const header = document.createElement("div");
    header.className = "stmr-result-header";

    const meta = document.createElement("div");
    meta.className = "stmr-result-meta";

    const badgeIndex = document.createElement("span");
    badgeIndex.className = "stmr-badge";
    badgeIndex.textContent = `候选 ${index + 1}/${total}`;

    const badgeStyle = document.createElement("span");
    badgeStyle.className = "stmr-badge secondary";
    badgeStyle.textContent = candidate.style;

    meta.append(badgeIndex, badgeStyle);
    header.append(meta);

    const body = document.createElement("pre");
    body.className = "stmr-result-text";
    body.textContent = candidate.text;

    const actions = document.createElement("div");
    actions.className = "stmr-result-actions";
    actions.append(
        createActionButton("替换输入框", () => writeToInput(candidate.text, "replace")),
        createActionButton("追加到输入框", () => writeToInput(candidate.text, "append")),
        createActionButton("复制", async () => {
            await copyToClipboard(candidate.text);
        }),
    );

    card.append(header, body, actions);
    state.ui.resultsList.append(card);
}

function buildPrompt({ style, lengthInstruction, extraInstructions, draftText }) {
    const rules = [
        "你是聊天帮答助手，要基于当前完整对话上下文，为用户写一条下一句可直接发送的回复。",
        "只输出最终回复正文，不要解释，不要标题，不要编号，不要加引号。",
        "回复必须站在用户这一侧，以用户口吻发送给当前对话对象。",
        "保持当前世界观、人物关系、语气和上下文连续，不要跳戏，不要总结剧情。",
        `目标风格：${style}。`,
        `长度要求：${lengthInstruction || DEFAULT_SETTINGS.lengthInstruction}`,
    ];

    if (extraInstructions) {
        rules.push(`额外要求：${extraInstructions}`);
    }

    if (draftText) {
        rules.push(`输入框里已有一份草稿/意图，请保留核心意思并重写得更自然：${draftText}`);
    } else {
        rules.push("如果当前上下文没有明显可回复点，就给出一条自然、推进对话的简洁回复。");
    }

    return rules.join("\n");
}

async function generateOneCandidate({ style, settings, draftText }) {
    const context = SillyTavern.getContext();
    const quietPrompt = buildPrompt({
        style,
        lengthInstruction: settings.lengthInstruction,
        extraInstructions: settings.extraInstructions,
        draftText,
    });

    const result = await context.generateQuietPrompt({
        quietPrompt,
        responseLength: settings.responseLength,
        quietName: "Reply Assistant",
        removeReasoning: true,
        trimToSentence: false,
    });

    return String(result ?? "").trim();
}

async function generateCandidates() {
    if (state.isGenerating) {
        return;
    }

    const settings = readPanelSettings();
    const context = SillyTavern.getContext();

    if (!context.chat?.length) {
        toastr.warning("当前没有可用聊天上下文。", "多候选帮答");
        openPanel();
        clearResults("先进入一个聊天，再生成候选回复。");
        return;
    }

    const styles = buildStyleSequence(settings.replyCount, settings.stylesText);
    const draftText = settings.useInputDraft ? getDraftText() : "";
    const token = Date.now();
    state.generationToken = token;
    state.stopAfterCurrent = false;

    openPanel();
    clearResults("正在生成中...");
    setGeneratingUi(true);
    setPanelNote(`准备生成 ${styles.length} 条候选，每条都会单独请求一次模型。`);
    updateProgress(0, styles.length);

    state.ui.resultsList.replaceChildren();

    try {
        for (let index = 0; index < styles.length; index += 1) {
            if (state.generationToken !== token) {
                return;
            }

            const style = styles[index];
            setPanelNote(`正在生成第 ${index + 1}/${styles.length} 条：${style}`);

            const text = await generateOneCandidate({
                style,
                settings,
                draftText,
            });

            if (!text) {
                throw new Error(`第 ${index + 1} 条候选返回了空内容。`);
            }

            appendCandidateCard({ style, text }, index, styles.length);
            updateProgress(index + 1, styles.length);

            if (state.stopAfterCurrent) {
                setPanelNote(`已停止排队，保留前 ${index + 1} 条候选。`);
                toastr.info("已停止后续候选生成。", "多候选帮答");
                return;
            }
        }

        setPanelNote(`已完成 ${styles.length} 条候选生成。`);
        toastr.success(`已生成 ${styles.length} 条候选回复。`, "多候选帮答");
    } catch (error) {
        console.error("[SillyTavern-MultiReply-Assistant] generation failed", error);

        if (!state.ui.resultsList.children.length) {
            clearResults(`生成失败：${error.message}`);
        }

        setPanelNote(`生成中断：${error.message}`);
        toastr.error(error.message || "生成失败，请检查模型连接。", "多候选帮答");
    } finally {
        if (state.generationToken === token) {
            setGeneratingUi(false);
            state.stopAfterCurrent = false;
        }
    }
}

function openPanel() {
    state.ui.overlay.classList.add("is-visible");
    document.body.classList.add("stmr-panel-open");
}

function closePanel() {
    state.ui.overlay.classList.remove("is-visible");
    document.body.classList.remove("stmr-panel-open");
}

function bindPanel() {
    const { overlay, panel } = state.ui;
    const form = state.ui.form;

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            closePanel();
        }
    });

    state.ui.closeButton.addEventListener("click", closePanel);
    state.ui.generateButton.addEventListener("click", async () => {
        await generateCandidates();
    });
    state.ui.stopButton.addEventListener("click", () => {
        state.stopAfterCurrent = true;
        setPanelNote("将在当前这条候选完成后停止。");
    });

    const syncOnInput = () => {
        readPanelSettings();
    };

    form.replyCount.addEventListener("input", syncOnInput);
    form.responseLength.addEventListener("input", syncOnInput);
    form.lengthInstruction.addEventListener("input", syncOnInput);
    form.stylesText.addEventListener("input", syncOnInput);
    form.extraInstructions.addEventListener("input", syncOnInput);
    form.useInputDraft.addEventListener("input", syncOnInput);

    window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && state.ui.overlay.classList.contains("is-visible")) {
            closePanel();
        }
    });
}

function createPanel() {
    if (state.ui.overlay) {
        return;
    }

    const overlay = document.createElement("div");
    overlay.id = PANEL_OVERLAY_ID;
    overlay.className = "stmr-overlay";
    overlay.innerHTML = `
        <aside id="${PANEL_ID}" class="stmr-panel">
            <div class="stmr-panel-header">
                <div class="stmr-panel-title">
                    <h3>多候选帮答</h3>
                    <p>按不同风格帮你起草下一句回复，可直接替换或追加到输入框。</p>
                </div>
                <div class="stmr-panel-actions">
                    <button type="button" class="menu_button" data-stmr-action="generate">开始生成</button>
                    <button type="button" class="menu_button stmr-stop-hidden" data-stmr-action="stop">停止排队</button>
                    <button type="button" class="menu_button" data-stmr-action="close">关闭</button>
                </div>
            </div>
            <div class="stmr-panel-config">
                <div class="stmr-panel-config-grid">
                    <label>
                        <span>候选数量</span>
                        <input id="stmr_panel_reply_count" class="text_pole" type="number" min="1" max="12" step="1" />
                    </label>
                    <label>
                        <span>生成长度上限</span>
                        <input id="stmr_panel_response_length" class="text_pole" type="number" min="16" max="1000" step="1" />
                    </label>
                </div>
                <label>
                    <span>文本长度要求</span>
                    <input id="stmr_panel_length_instruction" class="text_pole" type="text" />
                </label>
                <label class="checkbox_label">
                    <input id="stmr_panel_use_input_draft" type="checkbox" />
                    <span>把输入框现有内容作为草稿/意图参考</span>
                </label>
                <label>
                    <span>风格列表（每行一个）</span>
                    <textarea id="stmr_panel_styles_text" class="text_pole textarea_compact" rows="6"></textarea>
                </label>
                <label>
                    <span>额外要求</span>
                    <textarea id="stmr_panel_extra_instructions" class="text_pole textarea_compact" rows="3"></textarea>
                </label>
                <div class="stmr-panel-note" data-stmr-note></div>
            </div>
            <div class="stmr-panel-results">
                <div class="stmr-results-shell">
                    <div class="stmr-progress-row">
                        <div class="stmr-progress" aria-hidden="true">
                            <div class="stmr-progress-bar" data-stmr-progress-bar></div>
                        </div>
                        <div class="stmr-progress-label" data-stmr-progress-label>0/0</div>
                    </div>
                    <div class="stmr-results-list" data-stmr-results></div>
                </div>
            </div>
        </aside>
    `;

    document.body.append(overlay);

    state.ui.overlay = overlay;
    state.ui.panel = overlay.querySelector(`#${PANEL_ID}`);
    state.ui.note = overlay.querySelector("[data-stmr-note]");
    state.ui.resultsList = overlay.querySelector("[data-stmr-results]");
    state.ui.progressBar = overlay.querySelector("[data-stmr-progress-bar]");
    state.ui.progressLabel = overlay.querySelector("[data-stmr-progress-label]");
    state.ui.generateButton = overlay.querySelector('[data-stmr-action="generate"]');
    state.ui.stopButton = overlay.querySelector('[data-stmr-action="stop"]');
    state.ui.closeButton = overlay.querySelector('[data-stmr-action="close"]');
    state.ui.form = {
        replyCount: overlay.querySelector("#stmr_panel_reply_count"),
        responseLength: overlay.querySelector("#stmr_panel_response_length"),
        lengthInstruction: overlay.querySelector("#stmr_panel_length_instruction"),
        stylesText: overlay.querySelector("#stmr_panel_styles_text"),
        extraInstructions: overlay.querySelector("#stmr_panel_extra_instructions"),
        useInputDraft: overlay.querySelector("#stmr_panel_use_input_draft"),
    };

    bindPanel();
    syncPanelInputsFromSettings();
    setPanelNote("点击“开始生成”后，会按候选数量逐条请求模型。");
    clearResults();
}

function bindSettingsInputs() {
    $("#stmr_settings_enabled").on("input", () => {
        commitSettings({ enabled: Boolean($("#stmr_settings_enabled").prop("checked")) });
        ensureChatButton();
    });

    $("#stmr_settings_reply_count").on("input", () => {
        commitSettings({
            replyCount: clampNumber($("#stmr_settings_reply_count").val(), 1, 12, DEFAULT_SETTINGS.replyCount),
        });
        syncPanelInputsFromSettings();
    });

    $("#stmr_settings_response_length").on("input", () => {
        commitSettings({
            responseLength: clampNumber($("#stmr_settings_response_length").val(), 16, 1000, DEFAULT_SETTINGS.responseLength),
        });
        syncPanelInputsFromSettings();
    });

    $("#stmr_settings_length_instruction").on("input", () => {
        commitSettings({
            lengthInstruction: String($("#stmr_settings_length_instruction").val() ?? "").trim() || DEFAULT_SETTINGS.lengthInstruction,
        });
        syncPanelInputsFromSettings();
    });

    $("#stmr_settings_styles_text").on("input", () => {
        commitSettings({
            stylesText: String($("#stmr_settings_styles_text").val() ?? ""),
        });
        syncPanelInputsFromSettings();
    });

    $("#stmr_settings_extra_instructions").on("input", () => {
        commitSettings({
            extraInstructions: String($("#stmr_settings_extra_instructions").val() ?? "").trim(),
        });
        syncPanelInputsFromSettings();
    });

    $("#stmr_settings_use_input_draft").on("input", () => {
        commitSettings({
            useInputDraft: Boolean($("#stmr_settings_use_input_draft").prop("checked")),
        });
        syncPanelInputsFromSettings();
    });

    $("#stmr_open_panel").on("click", () => {
        openPanel();
    });

    $("#stmr_generate_from_settings").on("click", async () => {
        openPanel();
        await generateCandidates();
    });
}

async function mountSettings() {
    if (document.querySelector(".stmr-settings")) {
        syncSettingsInputsFromState();
        return;
    }

    const html = await renderExtensionTemplateAsync(TEMPLATE_ROOT, "settings");
    $("#extensions_settings").append(html);
    bindSettingsInputs();
    syncSettingsInputsFromState();
}

function observeLayout() {
    if (state.observer) {
        return;
    }

    state.observer = new MutationObserver(() => {
        ensureChatButton();
    });

    state.observer.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

jQuery(async () => {
    getSettings();
    createPanel();
    await mountSettings();
    ensureChatButton();
    observeLayout();
});
