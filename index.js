/**
 * Secrets & Revelations Tracker (SillyTavern Extension)
 * v0.5.4 — Fix: export download + import file button, popup handler timing
 *
 * BUGFIXES:
 *  - exportJson / importJson: removed `await` before Popup.show.text() —
 *    the promise resolves WHEN THE POPUP IS CLOSED, so all addEventListener
 *    calls after await ran on elements that no longer existed in the DOM.
 *    Fix: call Popup without await, then attach handlers via setTimeout(0).
 *  - importJson: file input change handler was also unreachable for same reason.
 *  - Minor: normalised a few stale variable references.
 */

(() => {
  'use strict';

  const MODULE_KEY  = 'secrets_revelations_tracker';
  const CHAT_KEY    = 'srt_state_v1';
  const PROMPT_TAG  = 'SRT_SECRETS_TRACKER';
  const FAB_POS_KEY = 'srt_fab_pos_v1';
  const FAB_MARGIN  = 8;

  // Regex: ловим [REVEAL: текст] или [РАСКРЫТИЕ: текст] в ответе модели
  const REVEAL_RE = /\[(?:REVEAL|РАСКРЫТИЕ|REVEAL_SECRET):\s*([^\]]+)\]/gi;

  let lastFabDragTs = 0;
  let scanInProgress = false;

  const EXT_PROMPT_TYPES = Object.freeze({
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
  });

  const TAGS = Object.freeze({
    none:      { label: '—',            icon: '' },
    dangerous: { label: '💣 Опасные',   icon: '💣' },
    personal:  { label: '💔 Личные',    icon: '💔' },
    kompromat: { label: '🗡️ Компромат', icon: '🗡️' },
  });

  const defaultSettings = Object.freeze({
    enabled:      true,
    showWidget:   true,
    collapsed:    false,
    autoDetect:   true,
    scanDepth:    30,
    position:     EXT_PROMPT_TYPES.IN_PROMPT,
    depth:        0,
    // ── Свой API для сканирования ──
    apiEndpoint:  '',
    apiKey:       '',
    apiModel:     'gpt-4o-mini',
  });

  // ─── helpers ────────────────────────────────────────────────────────────────

  function ctx() { return SillyTavern.getContext(); }

  function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_KEY])
      extensionSettings[MODULE_KEY] = structuredClone(defaultSettings);
    for (const k of Object.keys(defaultSettings))
      if (!Object.hasOwn(extensionSettings[MODULE_KEY], k))
        extensionSettings[MODULE_KEY][k] = defaultSettings[k];
    return extensionSettings[MODULE_KEY];
  }

  function currentChatBoundKey() {
    const c = ctx();
    const chatId = (typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : null)
                   || c.chatId
                   || 'unknown_chat';
    const charId = c.characterId ?? c.groupId ?? 'unknown_char';
    return `${CHAT_KEY}__${charId}__${chatId}`;
  }

  async function getChatState() {
    const { chatMetadata, saveMetadata } = ctx();
    const key = currentChatBoundKey();

    // Миграция: если есть старый плоский ключ — переносим и удаляем
    if (chatMetadata[CHAT_KEY] && !chatMetadata[key]) {
      chatMetadata[key] = chatMetadata[CHAT_KEY];
      delete chatMetadata[CHAT_KEY];
      await saveMetadata();
    }

    if (!chatMetadata[key]) {
      chatMetadata[key] = {
        npcLabel:      '{{char}}',
        npcSecrets:    [],
        userSecrets:   [],
        mutualSecrets: [],
      };
      await saveMetadata();
    }
    return chatMetadata[key];
  }

  function makeId()        { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`; }
  function clamp(v, mn, mx){ return Math.max(mn, Math.min(mx, v)); }
  function clamp01(v)      { return Math.max(0, Math.min(1, v)); }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&','&amp;').replaceAll('<','&lt;')
      .replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
  }

  function getActiveNpcNameForUi() {
    const c = ctx();
    try {
      if (c.characterId !== undefined && c.characters?.[c.characterId]?.name)
        return c.characters[c.characterId].name;
      if (c.groupId !== undefined)
        return c.groups?.find?.(g => g.id === c.groupId)?.name ?? '{{char}}';
    } catch {}
    return '{{char}}';
  }

  function formatList(lines) {
    return lines.length ? lines.map(x => `- ${x}`).join('\n') : '[нет]';
  }

  function leverageScore(items) {
    return items.reduce((s, it) =>
      s + (it.tag === 'kompromat' || it.tag === 'dangerous' ? 2 : it.tag === 'personal' ? 1 : 0), 0);
  }

  // ─── last N messages from chat ───────────────────────────────────────────────

  function getRecentMessages(n = 40) {
    const { chat } = ctx();
    if (!Array.isArray(chat) || !chat.length) return '';
    const slice = chat.slice(-n);
    return slice.map(m => {
      const who = m.is_user ? '{{user}}' : (m.name || '{{char}}');
      const msg = (m.mes || '').trim();
      return `${who}: ${msg}`;
    }).join('\n\n');
  }

  // ─── Character card helper ───────────────────────────────────────────────────

  function getCharacterCard() {
    const c = ctx();
    try {
      const char = c.characters?.[c.characterId];
      if (!char) return '';
      const parts = [];
      if (char.name)        parts.push(`Имя: ${char.name}`);
      if (char.description) parts.push(`Описание: ${char.description}`);
      if (char.personality) parts.push(`Личность: ${char.personality}`);
      if (char.scenario)    parts.push(`Сценарий: ${char.scenario}`);
      if (char.mes_example) parts.push(`Примеры диалогов: ${char.mes_example}`);
      return parts.join('\n\n');
    } catch { return ''; }
  }

  // ─── AI API helpers ───────────────────────────────────────────────────────────

  function getBaseUrl() {
    const s = getSettings();
    return (s.apiEndpoint || '').trim()
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/, '')
      .replace(/\/v1$/, '');
  }

  async function fetchModelsForSelect() {
    const base   = getBaseUrl();
    const apiKey = (getSettings().apiKey || '').trim();
    if (!base || !apiKey) throw new Error('Укажи Endpoint и API Key');
    const resp = await fetch(`${base}/v1/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return (data.data || data.models || [])
      .map(m => (typeof m === 'string' ? m : m.id))
      .filter(Boolean)
      .sort();
  }

  async function onRefreshModels() {
    const $btn = $('#srt_refresh_models');
    const $sel = $('#srt_api_model_select');
    if (!$btn.length || !$sel.length) return;
    $btn.prop('disabled', true).text('⏳');
    try {
      const models  = await fetchModelsForSelect();
      const current = getSettings().apiModel || '';
      $sel.html('<option value="">-- выбери модель --</option>');
      models.forEach(id => {
        const opt = document.createElement('option');
        opt.value = id; opt.textContent = id;
        if (id === current) opt.selected = true;
        $sel.append(opt);
      });
      if (!models.length) toastr.warning('Список моделей пуст');
      else toastr.success(`Загружено моделей: ${models.length}`);
    } catch (e) {
      toastr.error(`[SRT] Ошибка загрузки моделей: ${e.message}`);
    } finally {
      $btn.prop('disabled', false).text('🔄');
    }
  }

  async function aiGenerate(userPrompt, systemPrompt) {
    const s    = getSettings();
    const base = getBaseUrl();
    const key  = (s.apiKey || '').trim();

    if (!base || !key) {
      throw new Error(
        'Не настроен API для сканирования.\n' +
        'Зайди в настройки расширения → раздел "API для сканирования" → ' +
        'укажи Endpoint и API Key, затем выбери модель кнопкой 🔄'
      );
    }

    const url  = `${base}/v1/chat/completions`;
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
          model:       s.apiModel || 'gpt-4o-mini',
          max_tokens:  2048,
          temperature: 0.2,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   },
          ],
        }),
      });
    } catch (netErr) {
      throw new Error(`Сетевая ошибка при подключении к ${url}: ${netErr.message}`);
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      throw new Error(`API вернул ${resp.status}: ${errText.slice(0, 400)}`);
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content
                 ?? data.choices?.[0]?.text
                 ?? data.content?.[0]?.text   // Anthropic
                 ?? null;

    if (content === null || content === '') {
      throw new Error(
        `API вернул пустой ответ. Сырой ответ:\n${JSON.stringify(data).slice(0, 500)}`
      );
    }

    return content;
  }

  // ─── PROMPT BLOCK ────────────────────────────────────────────────────────────

  function buildPromptBlock(state) {
    const npcKnownToUser    = state.npcSecrets.filter(s =>  s.knownToUser);
    const npcHiddenFromUser = state.npcSecrets.filter(s => !s.knownToUser);
    const userKnownToNpc    = state.userSecrets.filter(s =>  s.knownToNpc);

    const revealed = npcKnownToUser.length + state.userSecrets.length + state.mutualSecrets.length;
    const hidden   = npcHiddenFromUser.length;

    const fmt = arr => formatList(arr.map(s => `${s.text}${TAGS[s.tag]?.icon ? ' ' + TAGS[s.tag].icon : ''}`));

    const npcLeverage  = leverageScore(userKnownToNpc);
    const userLeverage = leverageScore(npcKnownToUser);
    const balance = npcLeverage > userLeverage ? '{{char}}' : userLeverage > npcLeverage ? '{{user}}' : 'Равный';

    return `[ТРЕКЕР СЕКРЕТОВ И РАСКРЫТИЙ]

Отслеживай секреты, скрытую информацию и раскрытия между {{user}} и {{char}}.

<КАТЕГОРИИ>
🔓 Раскрыто (известно {{user}})  🔒 Скрыто  💣 Опасные  💔 Личные  🗡️ Компромат
</КАТЕГОРИИ>

<СОСТОЯНИЕ>
Всего: ${hidden} скрытых / ${revealed} известных {{user}}

Секреты {{user}}, известные {{char}}:
${fmt(userKnownToNpc)}

Секреты {{char}}, известные {{user}}:
${fmt(npcKnownToUser)}

Общие секреты:
${fmt(state.mutualSecrets)}

Баланс компромата: [${balance}]
</СОСТОЯНИЕ>

<ИНСТРУКЦИЯ ДЛЯ МОДЕЛИ>
Если в ходе RP секрет раскрывается или становится известен другой стороне — ОБЯЗАТЕЛЬНО добавь в конец своего ответа маркер:
[REVEAL: краткое описание раскрытого секрета]
Это нужно для автоматического обновления трекера. Маркер должен быть на отдельной строке.
</ИНСТРУКЦИЯ ДЛЯ МОДЕЛИ>
`;
  }

  async function updateInjectedPrompt() {
    const s = getSettings();
    const { setExtensionPrompt } = ctx();
    if (!s.enabled) {
      setExtensionPrompt(PROMPT_TAG, '', EXT_PROMPT_TYPES.IN_PROMPT, 0, true);
      return;
    }
    const state = await getChatState();
    setExtensionPrompt(PROMPT_TAG, buildPromptBlock(state), s.position, s.depth, true);
    await renderWidget();
  }

  // ─── AUTO-SCAN ───────────────────────────────────────────────────────────────

  async function scanChatForSecrets() {
    if (scanInProgress) return toastr.warning('[SRT] Сканирование уже идёт…');
    const history = getRecentMessages(getSettings().scanDepth || 30);
    if (!history) return toastr.warning('[SRT] История чата пуста');

    scanInProgress = true;
    const $btn = $('#srt_scan_btn');
    $btn.prop('disabled', true).text('⏳ Анализ…');

    try {
      const state = await getChatState();
      const { saveMetadata } = ctx();

      const existingList = [
        ...state.npcSecrets.map(s    => `[{{char}}] ${s.text}`),
        ...state.userSecrets.map(s   => `[{{user}}] ${s.text}`),
        ...state.mutualSecrets.map(s => `[общий] ${s.text}`),
      ];
      const existingBlock = existingList.length
        ? `\nУЖЕ ИЗВЕСТНЫЕ СЕКРЕТЫ (не добавляй их повторно, даже другими словами):\n${existingList.map(x => `- ${x}`).join('\n')}\n`
        : '';

      const system = `Ты аналитик RP-диалогов. Извлекай ТОЛЬКО информацию которую один персонаж скрывает от другого или которая имеет значение для развития сюжета.

ЧТО СЧИТАЕТСЯ СЕКРЕТОМ:
- Факты о прошлом персонажа которые он скрывает (преступления, травмы, отношения)
- Чувства/намерения которые персонаж не высказывает вслух
- Информация которой владеет один персонаж но не другой
- Зависимости, слабости, уязвимости
- Планы, цели, скрытые мотивы
- Компромат, тайны которые можно использовать как рычаг

ЧТО НЕ ЯВЛЯЕТСЯ СЕКРЕТОМ:
- Обычные факты открыто сказанные в диалоге
- Описания обстановки, действий без скрытого смысла
- Общеизвестные факты о персонаже

ТЕГИ — выбери ОДИН для каждого секрета:
- "dangerous"  → угроза жизни, насилие, серьёзный физический вред, зависимости
- "personal"   → эмоциональные тайны, личные травмы, скрытые чувства, отношения
- "kompromat"  → информация которую можно использовать как рычаг давления или шантаж
- "none"       → только если секрет не подходит ни под одну категорию выше

Верни ТОЛЬКО валидный JSON без преамбулы и markdown-блоков:
{
  "npcSecrets": [
    {"text": "краткое описание до 15 слов", "tag": "dangerous", "knownToUser": false},
    {"text": "краткое описание до 15 слов", "tag": "personal", "knownToUser": true}
  ],
  "userSecrets": [
    {"text": "краткое описание до 15 слов", "tag": "kompromat", "knownToNpc": false}
  ],
  "mutualSecrets": [
    {"text": "краткое описание до 15 слов", "tag": "personal"}
  ]
}
ВАЖНО: поле "tag" должно быть ТОЧНО одним из: "dangerous", "personal", "kompromat", "none"
knownToUser/knownToNpc=true ТОЛЬКО если в тексте явно видно что персонаж это узнал
Если секретов нет — верни пустые массивы${existingBlock}`;

      const charCard = getCharacterCard();
      const charBlock = charCard
        ? `\n\nКАРТОЧКА ПЕРСОНАЖА {{char}} (используй для понимания характера, мотивов и возможных секретов):\n${charCard}`
        : '';

      const user = `Вот последние сообщения RP-чата:${charBlock}

━━━ ИСТОРИЯ ЧАТА ━━━
${history}

Извлеки все секреты, тайны и скрытую информацию. Также учти карточку персонажа — там могут быть упомянуты скрытые черты, прошлое или мотивы которые ещё не раскрылись в чате но присутствуют как скрытые секреты {{char}}.`;

      const raw = await aiGenerate(user, system);
      if (!raw) throw new Error('Пустой ответ от модели');

      function extractJson(s) {
        let t = s.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        const start = t.indexOf('{');
        const end   = t.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('JSON-объект не найден в ответе модели');
        t = t.slice(start, end + 1);
        t = t.replace(/,\s*([}\]])/g, '$1');
        try { JSON.parse(t); return t; } catch {}
        const fixed = t
          .replace(/([{,\[])\s*'([^'\\]*)'\s*:/g, (_, pre, key) => `${pre} "${key}":`)
          .replace(/:\s*'([^'\\]*)'/g, (_, val) => `: "${val}"`);
        return fixed.replace(/,\s*([}\]])/g, '$1');
      }

      const parsed = JSON.parse(extractJson(raw));

      let addedNpc = 0, addedUser = 0, addedMutual = 0;

      const norm = s => s.toLowerCase().replace(/[^\wа-яёa-z0-9\s]/gi, '').replace(/\s+/g, ' ').trim();

      function similarity(a, b) {
        const na = norm(a), nb = norm(b);
        if (na.includes(nb) || nb.includes(na)) return 1;
        const wa = new Set(na.split(' ').filter(w => w.length >= 4));
        const wb = new Set(nb.split(' ').filter(w => w.length >= 4));
        if (!wa.size && !wb.size) return na === nb ? 1 : 0;
        if (wa.size < 2 || wb.size < 2) {
          const wa2 = new Set(na.split(' ').filter(w => w.length >= 3));
          const wb2 = new Set(nb.split(' ').filter(w => w.length >= 3));
          let c2 = 0; for (const w of wa2) if (wb2.has(w)) c2++;
          return c2 / Math.max(wa2.size, wb2.size);
        }
        let common = 0;
        for (const w of wa) if (wb.has(w)) common++;
        return common / Math.max(wa.size, wb.size);
      }

      const SIM_THRESHOLD = 0.45;

      const existingPool = [
        ...state.npcSecrets.map(s => s.text),
        ...state.userSecrets.map(s => s.text),
        ...state.mutualSecrets.map(s => s.text),
      ];

      function isDuplicate(text) {
        return existingPool.some(ex => similarity(ex, text) >= SIM_THRESHOLD);
      }

      const VALID_TAGS = new Set(['none', 'dangerous', 'personal', 'kompromat']);

      function normalizeTag(raw) {
        if (!raw) return 'none';
        const t = String(raw).toLowerCase().trim();
        if (VALID_TAGS.has(t)) return t;
        if (t.includes('danger') || t.includes('опасн') || t.includes('harm') || t.includes('violent')) return 'dangerous';
        if (t.includes('personal') || t.includes('личн') || t.includes('эмоц') || t.includes('trauma')) return 'personal';
        if (t.includes('kompro') || t.includes('компро') || t.includes('blackmail') || t.includes('lever')) return 'kompromat';
        return 'none';
      }

      for (const it of (parsed.npcSecrets || [])) {
        if (!it.text || isDuplicate(it.text)) continue;
        state.npcSecrets.unshift({ id: makeId(), text: it.text, tag: normalizeTag(it.tag), knownToUser: !!it.knownToUser });
        existingPool.push(it.text);
        addedNpc++;
      }
      for (const it of (parsed.userSecrets || [])) {
        if (!it.text || isDuplicate(it.text)) continue;
        state.userSecrets.unshift({ id: makeId(), text: it.text, tag: normalizeTag(it.tag), knownToNpc: !!it.knownToNpc });
        existingPool.push(it.text);
        addedUser++;
      }
      for (const it of (parsed.mutualSecrets || [])) {
        if (!it.text || isDuplicate(it.text)) continue;
        state.mutualSecrets.unshift({ id: makeId(), text: it.text, tag: normalizeTag(it.tag) });
        existingPool.push(it.text);
        addedMutual++;
      }

      const added = addedNpc + addedUser + addedMutual;

      await saveMetadata();
      await saveBackup();
      await updateInjectedPrompt();
      await renderDrawer();

      if (added === 0) {
        toastr.info('🔍 Сканирование завершено — новых секретов не найдено', 'SRT', { timeOut: 4000 });
      } else {
        const parts = [];
        if (addedNpc)    parts.push(`📖 {{char}}: ${addedNpc}`);
        if (addedUser)   parts.push(`👁️ {{user}}: ${addedUser}`);
        if (addedMutual) parts.push(`🤝 Общие: ${addedMutual}`);
        toastr.success(
          `Найдено и добавлено секретов: <b>${added}</b><br><small>${parts.join(' &nbsp;·&nbsp; ')}</small>`,
          'SRT Сканирование',
          { timeOut: 6000, escapeHtml: false }
        );
      }
    } catch (e) {
      console.error('[SRT] scan failed', e);
      const hint = e.message.includes('JSON') ? ' (модель вернула не-JSON ответ)' : '';
      toastr.error(`[SRT] Ошибка анализа: ${e.message}${hint}`, 'SRT', { timeOut: 8000 });
    } finally {
      scanInProgress = false;
      $btn.prop('disabled', false).text('🔍 Сканировать чат');
    }
  }

  // ─── AUTO-DETECT reveals ─────────────────────────────────────────────────────

  async function detectRevealInMessage(messageText) {
    if (!messageText) return;
    const settings = getSettings();
    if (!settings.autoDetect) return;

    const matches = [...messageText.matchAll(REVEAL_RE)];
    if (!matches.length) return;

    const state = await getChatState();
    const { saveMetadata } = ctx();
    let changed = false;

    for (const m of matches) {
      const revealedText = m[1].trim();
      if (!revealedText) continue;

      const candidate = state.npcSecrets.find(s =>
        !s.knownToUser &&
        (s.text.toLowerCase().includes(revealedText.toLowerCase()) ||
         revealedText.toLowerCase().includes(s.text.toLowerCase().slice(0, 20)))
      );

      if (candidate) {
        candidate.knownToUser = true;
        changed = true;
        toastr.info(`🔓 Секрет раскрыт: «${candidate.text}»`, 'SRT Авто-детект', { timeOut: 5000 });
      } else {
        state.npcSecrets.unshift({ id: makeId(), text: revealedText, tag: 'none', knownToUser: true });
        changed = true;
        toastr.info(`🔓 Новый раскрытый секрет: «${revealedText}»`, 'SRT Авто-детект', { timeOut: 5000 });
      }
    }

    if (changed) {
      await saveMetadata();
      await updateInjectedPrompt();
      await saveBackup();
      if ($('#srt_drawer').hasClass('srt-open')) renderDrawer();
    }
  }

  // ─── FAB widget ──────────────────────────────────────────────────────────────

  function vpW() { return (window.visualViewport?.width  || window.innerWidth);  }
  function vpH() { return (window.visualViewport?.height || window.innerHeight); }

  function getFabDimensions() {
    const el = document.getElementById('srt_fab');
    if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
      return { W: el.offsetWidth, H: el.offsetHeight };
    }
    const w = vpW();
    if (w <= 480)  return { W: 60, H: 58 };
    if (w <= 1024) return { W: 66, H: 62 };
    return { W: 64, H: 58 };
  }

  function ensureFab() {
    if ($('#srt_fab').length) return;
    $('body').append(`
      <div id="srt_fab">
        <button type="button" id="srt_fab_btn" title="Открыть трекер секретов">
          <div>🔐</div>
          <div class="srt-mini"><span class="srt-count" id="srt_fab_revealed">0</span> /
          <span class="srt-count-hidden" id="srt_fab_hidden">0</span></div>
        </button>
        <button type="button" id="srt_fab_hide" title="Скрыть виджет">✕</button>
      </div>
    `);
    $('#srt_fab_btn').on('click', (ev) => {
      if (Date.now() - lastFabDragTs < 350) { ev.preventDefault(); ev.stopPropagation(); return; }
      openDrawer(true);
    });
    $('#srt_fab_hide').on('click', async () => {
      const s = getSettings();
      s.showWidget = false;
      ctx().saveSettingsDebounced();
      await renderWidget();
      toastr.info('Виджет скрыт (можно включить в настройках расширения)');
    });
    initFabDrag();
    applyFabPosition();
  }

  function clampFabPos(left, top) {
    const { W, H } = getFabDimensions();
    const maxL = Math.max(FAB_MARGIN, vpW() - W - FAB_MARGIN);
    const maxT = Math.max(FAB_MARGIN, vpH() - H - FAB_MARGIN);
    return {
      left: clamp(left, FAB_MARGIN, maxL),
      top:  clamp(top,  FAB_MARGIN, maxT),
    };
  }

  function applyFabPosition() {
    const el = document.getElementById('srt_fab');
    if (!el) return;
    el.style.transform = 'none';
    el.style.right  = 'auto';
    el.style.bottom = 'auto';
    const { W, H } = getFabDimensions();

    try {
      const raw = localStorage.getItem(FAB_POS_KEY);
      if (!raw) { setFabDefaultPosition(); return; }
      const pos = JSON.parse(raw);
      let left, top;
      if (typeof pos.x === 'number') {
        left = Math.round(pos.x * (vpW() - W - FAB_MARGIN * 2)) + FAB_MARGIN;
        top  = Math.round(pos.y * (vpH() - H - FAB_MARGIN * 2)) + FAB_MARGIN;
      } else if (typeof pos.left === 'number') {
        left = pos.left;
        top  = pos.top;
      } else {
        setFabDefaultPosition(); return;
      }
      const clamped = clampFabPos(left, top);
      el.style.left = clamped.left + 'px';
      el.style.top  = clamped.top  + 'px';
    } catch { setFabDefaultPosition(); }
  }

  function saveFabPositionPx(left, top) {
    const { W, H } = getFabDimensions();
    const clamped = clampFabPos(left, top);
    const rangeX = Math.max(1, vpW() - W - FAB_MARGIN * 2);
    const rangeY = Math.max(1, vpH() - H - FAB_MARGIN * 2);
    try {
      localStorage.setItem(FAB_POS_KEY, JSON.stringify({
        x:    clamp01((clamped.left - FAB_MARGIN) / rangeX),
        y:    clamp01((clamped.top  - FAB_MARGIN) / rangeY),
        left: clamped.left,
        top:  clamped.top,
      }));
    } catch {}
  }

  function setFabDefaultPosition() {
    const el = document.getElementById('srt_fab');
    if (!el) return;
    el.style.transform = 'none';
    el.style.right  = 'auto';
    el.style.bottom = 'auto';
    const { W, H } = getFabDimensions();
    const left = clamp(vpW() - W - FAB_MARGIN, FAB_MARGIN, vpW() - W - FAB_MARGIN);
    const top  = clamp(Math.round((vpH() - H) / 2), FAB_MARGIN, vpH() - H - FAB_MARGIN);
    el.style.left = left + 'px';
    el.style.top  = top  + 'px';
    saveFabPositionPx(left, top);
  }

  function initFabDrag() {
    const fab    = document.getElementById('srt_fab');
    const handle = document.getElementById('srt_fab_btn');
    if (!fab || !handle || fab.dataset.dragInit === '1') return;
    fab.dataset.dragInit = '1';

    let sx, sy, sl, st, moved = false;
    const THRESHOLD = 6;

    const onMove = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > THRESHOLD) { moved = true; fab.classList.add('srt-dragging'); }
      if (!moved) return;
      const pos = clampFabPos(sl + dx, st + dy);
      fab.style.left   = pos.left + 'px';
      fab.style.top    = pos.top  + 'px';
      fab.style.right  = 'auto'; fab.style.bottom = 'auto';
      ev.preventDefault(); ev.stopPropagation();
    };

    const onEnd = (ev) => {
      try { handle.releasePointerCapture(ev.pointerId); } catch {}
      document.removeEventListener('pointermove', onMove, { passive: false });
      document.removeEventListener('pointerup',   onEnd,  { passive: true });
      document.removeEventListener('pointercancel', onEnd, { passive: true });
      if (moved) { saveFabPositionPx(parseInt(fab.style.left) || 0, parseInt(fab.style.top) || 0); lastFabDragTs = Date.now(); }
      moved = false;
      fab.classList.remove('srt-dragging');
    };

    handle.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const { W, H } = getFabDimensions();
      const curLeft = parseInt(fab.style.left) || (vpW() - W - FAB_MARGIN);
      const curTop  = parseInt(fab.style.top)  || Math.round((vpH() - H) / 2);
      const pos = clampFabPos(curLeft, curTop);
      fab.style.left   = pos.left + 'px';
      fab.style.top    = pos.top  + 'px';
      fab.style.right  = 'auto'; fab.style.bottom = 'auto'; fab.style.transform = 'none';
      sx = ev.clientX; sy = ev.clientY;
      sl = pos.left; st = pos.top;
      moved = false;
      try { handle.setPointerCapture(ev.pointerId); } catch {}
      document.addEventListener('pointermove', onMove, { passive: false });
      document.addEventListener('pointerup',   onEnd,  { passive: true });
      document.addEventListener('pointercancel', onEnd, { passive: true });
      ev.preventDefault(); ev.stopPropagation();
    }, { passive: false });

    let resizeT = null;
    const onResize = () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => { applyFabPosition(); }, 200);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => { clearTimeout(resizeT); resizeT = setTimeout(applyFabPosition, 350); });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onResize);
    }
  }

  // ─── DRAWER ──────────────────────────────────────────────────────────────────

  function ensureDrawer() {
    if ($('#srt_drawer').length) return;
    $('body').append(`
      <aside id="srt_drawer" aria-hidden="true">
        <header>
          <div class="topline">
            <div class="title">🔐 СЕКРЕТЫ И ТАЙНЫ</div>
            <button type="button" id="srt_close" title="Закрыть" style="pointer-events:auto">✕</button>
          </div>
          <div class="sub" id="srt_subtitle"></div>
        </header>
        <div class="content" id="srt_content"></div>
        <div class="footer">
          <button type="button" id="srt_scan_btn">🔍 Сканировать чат</button>
          <button type="button" id="srt_quick_debug">🐛 Дебаг</button>
          <button type="button" id="srt_quick_test">🧪 Тест API</button>
          <button type="button" id="srt_quick_prompt">Промпт</button>
          <button type="button" id="srt_quick_export">Экспорт</button>
          <button type="button" id="srt_quick_import">Импорт</button>
          <button type="button" id="srt_close2" style="pointer-events:auto">Закрыть</button>
        </div>
      </aside>
    `);

    document.getElementById('srt_close').addEventListener('click',  () => openDrawer(false), true);
    document.getElementById('srt_close2').addEventListener('click', () => openDrawer(false), true);

    $(document)
      .off('click.srt_actions')
      .on('click.srt_actions', '#srt_quick_prompt',  () => showPromptPreview())
      .on('click.srt_actions', '#srt_quick_debug',   () => showDebugInfo())
      .on('click.srt_actions', '#srt_quick_test',    () => testApiAndJson())
      .on('click.srt_actions', '#srt_quick_export',  () => exportJson())
      .on('click.srt_actions', '#srt_quick_import',  () => importJson())
      .on('click.srt_actions', '#srt_scan_btn',      () => scanChatForSecrets());
  }

  function openDrawer(open) {
    ensureDrawer();
    const drawer = document.getElementById('srt_drawer');
    if (!drawer) return;

    if (open) {
      if (!document.getElementById('srt_overlay')) {
        const ov = document.createElement('div');
        ov.id = 'srt_overlay';
        document.body.insertBefore(ov, drawer);
        ov.addEventListener('click',      () => openDrawer(false), true);
        ov.addEventListener('touchstart', (e) => { e.preventDefault(); openDrawer(false); }, { passive: false, capture: true });
      }
      document.getElementById('srt_overlay').style.display = 'block';
      drawer.classList.add('srt-open');
      drawer.setAttribute('aria-hidden', 'false');
      renderDrawer();
    } else {
      drawer.classList.remove('srt-open');
      drawer.setAttribute('aria-hidden', 'true');
      const ov = document.getElementById('srt_overlay');
      if (ov) ov.style.display = 'none';
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('srt_drawer')?.classList.contains('srt-open'))
      openDrawer(false);
  });

  async function renderWidget() {
    const settings = getSettings();
    ensureFab();
    applyFabPosition();
    if (!settings.showWidget) { $('#srt_fab').hide(); return; }
    const state = await getChatState();
    const revealed = state.npcSecrets.filter(s => s.knownToUser).length + state.userSecrets.length + state.mutualSecrets.length;
    const hidden   = state.npcSecrets.filter(s => !s.knownToUser).length;
    $('#srt_fab_revealed').text(revealed);
    $('#srt_fab_hidden').text(hidden);
    $('#srt_fab').show();
  }

  function tagOptionsHtml(selected) {
    return Object.keys(TAGS).map(k =>
      `<option value="${k}" ${k === selected ? 'selected' : ''}>${escapeHtml(TAGS[k].label)}</option>`
    ).join('');
  }

  function renderItemRow(item, kind) {
    const icon = TAGS[item.tag]?.icon ?? '';
    const toggle = kind === 'npc'
      ? `<label title="Известно {{user}}"><input type="checkbox" class="srt_toggle_known" data-kind="npc"  data-id="${item.id}" ${item.knownToUser ? 'checked' : ''}> 🔓</label>`
      : kind === 'user'
      ? `<label title="Известно {{char}}"><input type="checkbox" class="srt_toggle_known" data-kind="user" data-id="${item.id}" ${item.knownToNpc ? 'checked' : ''}> 🔓</label>`
      : '';
    return `
      <div class="item" data-kind="${kind}" data-id="${item.id}">
        <div class="tag">${icon}</div>
        <div class="txt">${escapeHtml(item.text)}</div>
        ${toggle}
        <button class="srt_delete" data-kind="${kind}" data-id="${item.id}" title="Удалить">🗑️</button>
      </div>`;
  }

  async function renderDrawer() {
    ensureDrawer();
    const state    = await getChatState();
    const npcName  = getActiveNpcNameForUi();
    const settings = getSettings();

    $('#srt_subtitle').text(`Чат: ${npcName}  •  данные хранятся отдельно для каждого чата`);

    const revealed = state.npcSecrets.filter(s => s.knownToUser).length + state.userSecrets.length + state.mutualSecrets.length;
    const hidden   = state.npcSecrets.filter(s => !s.knownToUser).length;

    const html = `
      <div class="section">
        <div class="summary">
          <div class="pill">Раскрыто: <b class="g">${revealed}</b></div>
          <div class="pill">Скрыто: <b class="r">${hidden}</b></div>
          <label class="srt-autodetect-toggle" title="Авто-детект раскрытий по маркерам [REVEAL:...]">
            <input type="checkbox" id="srt_autodetect_cb" ${settings.autoDetect ? 'checked' : ''}> Авто-детект
          </label>
        </div>
        <div class="srt-scan-hint">
          Нажмите <b>🔍 Сканировать чат</b> — AI сам найдёт секреты в истории переписки.
        </div>
        <div class="srt-scan-depth-row">
          <label for="srt_scan_depth_slider">Глубина сканирования:</label>
          <input type="range" id="srt_scan_depth_slider" min="10" max="200" step="10" value="${settings.scanDepth || 30}">
          <span id="srt_scan_depth_val">${settings.scanDepth || 30}</span> сообщений
        </div>
      </div>

      <div class="section">
        <h4>📖 Секреты {{char}} <small>(🔓 = известно {{user}})</small></h4>
        <div class="list">
          ${state.npcSecrets.map(s => renderItemRow(s, 'npc')).join('') || '<div class="item"><div class="txt muted">—</div></div>'}
        </div>
        <div class="addrow">
          <input type="text" id="srt_add_npc_text" placeholder="Новый секрет {{char}}…">
          <select id="srt_add_npc_tag">${tagOptionsHtml('none')}</select>
          <label title="Уже известно {{user}}"><input type="checkbox" id="srt_add_npc_known"> известно</label>
          <button id="srt_add_npc_btn">Добавить</button>
        </div>
      </div>

      <div class="section">
        <h4>👁️ Секреты {{user}} <small>(🔓 = известно {{char}})</small></h4>
        <div class="list">
          ${state.userSecrets.map(s => renderItemRow(s, 'user')).join('') || '<div class="item"><div class="txt muted">—</div></div>'}
        </div>
        <div class="addrow">
          <input type="text" id="srt_add_user_text" placeholder="Новый секрет {{user}}…">
          <select id="srt_add_user_tag">${tagOptionsHtml('none')}</select>
          <label title="Известно {{char}}"><input type="checkbox" id="srt_add_user_known"> известно</label>
          <button id="srt_add_user_btn">Добавить</button>
        </div>
      </div>

      <div class="section">
        <h4>🤝 Общие секреты</h4>
        <div class="list">
          ${state.mutualSecrets.map(s => renderItemRow(s, 'mutual')).join('') || '<div class="item"><div class="txt muted">—</div></div>'}
        </div>
        <div class="addrow">
          <input type="text" id="srt_add_mutual_text" placeholder="Новый общий секрет…">
          <select id="srt_add_mutual_tag">${tagOptionsHtml('none')}</select>
          <button id="srt_add_mutual_btn">Добавить</button>
        </div>
      </div>
    `;

    $('#srt_content').html(html);

    $('#srt_add_npc_btn').on('click',    () => addSecret('npc'));
    $('#srt_add_user_btn').on('click',   () => addSecret('user'));
    $('#srt_add_mutual_btn').on('click', () => addSecret('mutual'));

    $('.srt_delete').on('click', ev => {
      deleteSecret($(ev.currentTarget).data('kind'), $(ev.currentTarget).data('id'));
    });
    $('.srt_toggle_known').on('input', ev => {
      toggleKnown($(ev.currentTarget).data('kind'), $(ev.currentTarget).data('id'), $(ev.currentTarget).prop('checked'));
    });

    $('#srt_autodetect_cb').on('input', ev => {
      const s = getSettings();
      s.autoDetect = $(ev.currentTarget).prop('checked');
      ctx().saveSettingsDebounced();
    });

    $('#srt_scan_depth_slider').on('input', ev => {
      const val = parseInt($(ev.currentTarget).val(), 10);
      $('#srt_scan_depth_val').text(val);
      const s = getSettings();
      s.scanDepth = val;
      ctx().saveSettingsDebounced();
    });
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────────

  async function addSecret(kind) {
    const state = await getChatState();
    const { saveMetadata } = ctx();

    if (kind === 'npc') {
      const text = String($('#srt_add_npc_text').val() ?? '').trim();
      if (!text) return toastr.warning('Введите текст секрета');
      state.npcSecrets.unshift({ id: makeId(), text, tag: String($('#srt_add_npc_tag').val() || 'none'), knownToUser: Boolean($('#srt_add_npc_known').prop('checked')) });
      $('#srt_add_npc_text').val(''); $('#srt_add_npc_known').prop('checked', false);
    } else if (kind === 'user') {
      const text = String($('#srt_add_user_text').val() ?? '').trim();
      if (!text) return toastr.warning('Введите текст секрета');
      state.userSecrets.unshift({ id: makeId(), text, tag: String($('#srt_add_user_tag').val() || 'none'), knownToNpc: Boolean($('#srt_add_user_known').prop('checked')) });
      $('#srt_add_user_text').val(''); $('#srt_add_user_known').prop('checked', false);
    } else {
      const text = String($('#srt_add_mutual_text').val() ?? '').trim();
      if (!text) return toastr.warning('Введите текст секрета');
      state.mutualSecrets.unshift({ id: makeId(), text, tag: String($('#srt_add_mutual_tag').val() || 'none') });
      $('#srt_add_mutual_text').val('');
    }

    await saveMetadata();
    await saveBackup();
    await updateInjectedPrompt();
    await renderDrawer();
  }

  async function deleteSecret(kind, id) {
    const state = await getChatState();
    const list = kind === 'npc' ? state.npcSecrets : kind === 'user' ? state.userSecrets : state.mutualSecrets;
    const idx = list.findIndex(x => x.id === id);
    if (idx >= 0) list.splice(idx, 1);
    await ctx().saveMetadata();
    await saveBackup();
    await updateInjectedPrompt();
    await renderDrawer();
  }

  async function toggleKnown(kind, id, value) {
    const state = await getChatState();
    if (kind === 'npc')  { const it = state.npcSecrets.find(x => x.id === id);  if (it) it.knownToUser = value; }
    if (kind === 'user') { const it = state.userSecrets.find(x => x.id === id); if (it) it.knownToNpc = value; }
    await ctx().saveMetadata();
    await saveBackup();
    await updateInjectedPrompt();
  }

  // ─── Test API ─────────────────────────────────────────────────────────────────

  async function testApiAndJson() {
    const $btn = $('#srt_quick_test');
    $btn.prop('disabled', true).text('⏳');
    let rawResponse = '';
    try {
      const system = `Верни ТОЛЬКО валидный JSON без преамбулы и markdown:
{"npcSecrets":[{"text":"тест секрет","tag":"none","knownToUser":false}],"userSecrets":[],"mutualSecrets":[]}`;
      const user = 'Это тестовый запрос. Верни ровно тот JSON что указан в инструкции.';

      rawResponse = await aiGenerate(user, system);

      function extractJson(s) {
        let t = s.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
        const start = t.indexOf('{'); const end = t.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('JSON-объект не найден в ответе');
        t = t.slice(start, end + 1);
        t = t.replace(/,\s*([}\]])/g, '$1');
        try { JSON.parse(t); return t; } catch {}
        const fixed = t
          .replace(/([{,\[])\s*'([^'\\]*)'\s*:/g, (_, pre, key) => `${pre} "${key}":`)
          .replace(/:\s*'([^'\\]*)'/g, (_, val) => `: "${val}"`);
        return fixed.replace(/,\s*([}\]])/g, '$1');
      }

      const cleaned = extractJson(rawResponse);
      const parsed  = JSON.parse(cleaned);

      const status = parsed.npcSecrets?.length > 0 ? '✅ УСПЕХ' : '⚠️ Парсинг ок, но секреты не найдены';
      await ctx().Popup.show.text('🧪 Тест API — результат',
        `<pre style="white-space:pre-wrap;font-size:11px;font-family:Consolas,monospace;max-height:65vh;overflow:auto">${escapeHtml(
          `${status}\n\n━━━ СЫРОЙ ОТВЕТ МОДЕЛИ ━━━\n${rawResponse}\n\n━━━ ПОСЛЕ ОЧИСТКИ ━━━\n${cleaned}\n\n━━━ РАСПАРСЕННЫЙ ОБЪЕКТ ━━━\n${JSON.stringify(parsed, null, 2)}`
        )}</pre>`
      );
    } catch (e) {
      await ctx().Popup.show.text('🧪 Тест API — ОШИБКА',
        `<pre style="white-space:pre-wrap;font-size:11px;font-family:Consolas,monospace;color:#e74c3c;max-height:65vh;overflow:auto">${escapeHtml(
          `❌ ${e.message}\n\n━━━ СЫРОЙ ОТВЕТ (если был) ━━━\n${rawResponse || '[пусто — ошибка до получения ответа]'}`
        )}</pre>`
      );
    } finally {
      $btn.prop('disabled', false).text('🧪 Тест API');
    }
  }

  async function showDebugInfo() {
    const state    = await getChatState();
    const settings = getSettings();
    const depth    = settings.scanDepth || 30;

    const injected = buildPromptBlock(state);
    const history  = getRecentMessages(depth);
    const existingList = [
      ...state.npcSecrets.map(s    => `[{{char}}] ${s.text}`),
      ...state.userSecrets.map(s   => `[{{user}}] ${s.text}`),
      ...state.mutualSecrets.map(s => `[общий] ${s.text}`),
    ];
    const existingBlock = existingList.length
      ? `\nУЖЕ ИЗВЕСТНЫЕ СЕКРЕТЫ (не добавляй их повторно, даже другими словами):\n${existingList.map(x => `- ${x}`).join('\n')}\n`
      : '';

    const scanSystem = `[SYSTEM PROMPT для сканирования]\n\nТы аналитик RP-диалогов. Извлекай ТОЛЬКО информацию которую один персонаж скрывает от другого...\n${existingBlock}`;
    const autoInfo = settings.autoDetect
      ? `✅ Включён\nТриггер: каждое сообщение {{char}} (MESSAGE_RECEIVED)\nРегекс: [REVEAL: текст] / [РАСКРЫТИЕ: текст]`
      : `❌ Выключен`;

    const card = getCharacterCard();
    const boundKey = currentChatBoundKey();
    const apiMode = getBaseUrl() && settings.apiKey
      ? `🔌 Свой API: ${getBaseUrl()}/v1/chat/completions\n   Модель: ${settings.apiModel || 'gpt-4o-mini'}`
      : `🔧 Встроенный ST generateRaw`;

    const out = [
      '╔══════════════════════════════════════╗',
      '║   SRT DEBUG — что уходит в модель    ║',
      '╚══════════════════════════════════════╝',
      '',
      '━━━ 0. ПРИВЯЗКА ЧАТА ━━━',
      `Ключ хранилища: ${boundKey}`,
      `Режим API: ${apiMode}`,
      '',
      '━━━ 1. ИНЖЕКТИРУЕМЫЙ ПРОМПТ (каждый ход) ━━━',
      '(модель видит это в каждом запросе пока включена инъекция)',
      '',
      injected,
      '',
      '━━━ 2. КАРТОЧКА ПЕРСОНАЖА ━━━',
      card || '[карточка не найдена или пуста]',
      '',
      '━━━ 3. СИСТЕМНЫЙ ПРОМПТ ДЛЯ СКАНИРОВАНИЯ ━━━',
      `(отправляется при нажатии "Сканировать", берёт последние ${depth} сообщений)`,
      '',
      scanSystem,
      '',
      '━━━ 4. ИСТОРИЯ ЧАТА ДЛЯ СКАНИРОВАНИЯ ━━━',
      `(последние ${depth} сообщений, всего символов: ${history.length})`,
      '',
      history.length > 1500 ? history.slice(0, 1500) + '\n... [обрезано для превью]' : (history || '[история пуста]'),
      '',
      '━━━ 5. АВТО-ДЕТЕКТ РАСКРЫТИЙ ━━━',
      autoInfo,
    ].join('\n');

    await ctx().Popup.show.text(
      'SRT Debug — полный дамп запросов',
      `<pre style="white-space:pre-wrap;font-size:11px;max-height:70vh;overflow:auto;font-family:Consolas,monospace">${escapeHtml(out)}</pre>`
    );
  }

  // ─── Backup ──────────────────────────────────────────────────────────────────

  const BACKUP_KEY = 'srt_backup_v1';

  async function saveBackup() {
    try {
      const state  = await getChatState();
      const key    = currentChatBoundKey();
      const raw    = localStorage.getItem(BACKUP_KEY);
      const store  = raw ? JSON.parse(raw) : {};
      store[key] = { ts: Date.now(), state: structuredClone(state) };
      const entries = Object.entries(store).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
      const trimmed = Object.fromEntries(entries.slice(0, 10));
      localStorage.setItem(BACKUP_KEY, JSON.stringify(trimmed));
    } catch (e) {
      console.warn('[SRT] saveBackup failed', e);
    }
  }

  function loadBackup() {
    try {
      const raw   = localStorage.getItem(BACKUP_KEY);
      if (!raw) return null;
      const store = JSON.parse(raw);
      const key   = currentChatBoundKey();
      return store[key] ?? null;
    } catch { return null; }
  }

  // ─── Download helper ─────────────────────────────────────────────────────────

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  }

  function validateImport(p) {
    if (!p || typeof p !== 'object') throw new Error('Не объект');
    return {
      npcLabel:      typeof p.npcLabel === 'string' ? p.npcLabel : '{{char}}',
      npcSecrets:    Array.isArray(p.npcSecrets)    ? p.npcSecrets    : [],
      userSecrets:   Array.isArray(p.userSecrets)   ? p.userSecrets   : [],
      mutualSecrets: Array.isArray(p.mutualSecrets) ? p.mutualSecrets : [],
    };
  }

  // ─── Export ──────────────────────────────────────────────────────────────────
  // BUG FIX: Previously used `await ctx().Popup.show.text(...)` — this promise
  // resolves only AFTER the popup is CLOSED, so all addEventListener calls
  // after it ran on DOM elements that no longer existed.
  // Fix: call Popup without await, then attach handlers via setTimeout(0)
  // so the popup has time to render before we query the DOM.

  async function exportJson() {
    const state   = await getChatState();
    const npcName = getActiveNpcNameForUi();
    const ts      = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
    const filename = `srt_${npcName.replace(/[^a-zа-яёA-ZА-ЯЁ0-9]/gi, '_').slice(0, 30)}_${ts}.json`;
    const json    = JSON.stringify(state, null, 2);
    const total   = state.npcSecrets.length + state.userSecrets.length + state.mutualSecrets.length;

    // ← NO await here: the promise resolves when popup is closed,
    //   so we must NOT await before attaching handlers.
    ctx().Popup.show.text('💾 Экспорт секретов',
      `<div style="font-family:Consolas,monospace;font-size:12px">
        <div style="margin-bottom:10px;opacity:.8">
          Персонаж: <b>${escapeHtml(npcName)}</b> · Секретов всего: <b>${total}</b>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <button id="srt_export_download" style="padding:8px 14px;background:rgba(46,204,113,0.15);border:1px solid rgba(46,204,113,0.5);color:#2ecc71;border-radius:8px;cursor:pointer;font-size:13px">
            ⬇️ Скачать файл
          </button>
          <button id="srt_export_copy" style="padding:8px 14px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.2);color:#eee;border-radius:8px;cursor:pointer;font-size:13px">
            📋 Скопировать JSON
          </button>
        </div>
        <pre id="srt_export_pre" style="white-space:pre-wrap;max-height:50vh;overflow:auto;background:rgba(0,0,0,0.3);padding:10px;border-radius:8px;font-size:11px">${escapeHtml(json)}</pre>
      </div>`
    );

    // setTimeout(0) gives the browser one tick to render the popup HTML into DOM
    setTimeout(() => {
      document.getElementById('srt_export_download')?.addEventListener('click', () => {
        downloadJson(filename, state);
        toastr.success(`Файл "${filename}" сохранён`);
      });
      document.getElementById('srt_export_copy')?.addEventListener('click', () => {
        navigator.clipboard?.writeText(json).then(
          () => toastr.success('JSON скопирован в буфер обмена'),
          () => toastr.error('Не удалось скопировать — выдели текст вручную')
        );
      });
    }, 0);
  }

  // ─── Import ──────────────────────────────────────────────────────────────────
  // Same BUG FIX: removed await before Popup call and use setTimeout(0)
  // so handlers are attached after the popup renders.

  async function importJson() {
    const backup   = loadBackup();
    const backupTs = backup ? new Date(backup.ts).toLocaleString('ru') : null;
    const backupTotal = backup
      ? (backup.state.npcSecrets?.length  || 0)
      + (backup.state.userSecrets?.length || 0)
      + (backup.state.mutualSecrets?.length || 0)
      : 0;

    // ← NO await here (same reason as exportJson)
    ctx().Popup.show.text('📂 Импорт секретов',
      `<div style="font-family:Consolas,monospace;font-size:12px">

        ${backup ? `
        <div style="margin-bottom:14px;padding:10px;background:rgba(46,204,113,0.08);border:1px solid rgba(46,204,113,0.3);border-radius:8px">
          <div style="color:#2ecc71;font-weight:700;margin-bottom:4px">💾 Авто-бэкап найден</div>
          <div style="opacity:.85">Сохранён: ${escapeHtml(backupTs)} · Секретов: ${backupTotal}</div>
          <button id="srt_import_from_backup" style="margin-top:8px;padding:7px 14px;background:rgba(46,204,113,0.2);border:1px solid rgba(46,204,113,0.5);color:#2ecc71;border-radius:8px;cursor:pointer;font-size:12px">
            ✅ Восстановить из бэкапа
          </button>
        </div>` : `
        <div style="margin-bottom:14px;padding:8px 10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:8px;opacity:.7">
          ℹ️ Авто-бэкап для этого чата не найден
        </div>`}

        <div style="margin-bottom:10px;font-weight:700;opacity:.9">Загрузить из файла или вставить JSON:</div>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <button id="srt_import_file_btn" style="padding:8px 14px;background:rgba(52,152,219,0.15);border:1px solid rgba(52,152,219,0.5);color:#5dade2;border-radius:8px;cursor:pointer;font-size:13px">
            📁 Выбрать файл (.json)
          </button>
        </div>
        <input type="file" id="srt_import_file_input" accept=".json,application/json" style="display:none">

        <textarea id="srt_import_textarea" placeholder="…или вставь JSON сюда вручную"
          style="width:100%;height:120px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.15);color:#eee;border-radius:8px;padding:8px;font-family:Consolas,monospace;font-size:11px;resize:vertical;box-sizing:border-box"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button id="srt_import_apply" style="padding:8px 14px;background:rgba(231,76,60,0.15);border:1px solid rgba(231,76,60,0.5);color:#e74c3c;border-radius:8px;cursor:pointer;font-size:13px">
            ⬆️ Применить JSON
          </button>
          <span id="srt_import_status" style="font-size:11px;opacity:.75;align-self:center"></span>
        </div>
      </div>`
    );

    // Attach all handlers after popup renders
    setTimeout(() => {
      // Восстановить из бэкапа
      document.getElementById('srt_import_from_backup')?.addEventListener('click', async () => {
        try {
          const p = validateImport(backup.state);
          await applyImport(p);
          toastr.success(`✅ Восстановлено из бэкапа (${backupTs})`);
        } catch (e) { toastr.error(`Ошибка восстановления: ${e.message}`); }
      });

      // Кнопка выбора файла — программно кликает на hidden input
      document.getElementById('srt_import_file_btn')?.addEventListener('click', () => {
        document.getElementById('srt_import_file_input')?.click();
      });

      // Читаем файл и кладём содержимое в textarea
      document.getElementById('srt_import_file_input')?.addEventListener('change', (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
          const text = e.target.result;
          const ta = document.getElementById('srt_import_textarea');
          if (ta) ta.value = text;
          const status = document.getElementById('srt_import_status');
          if (status) status.textContent = `📄 Загружен: ${file.name}`;
        };
        reader.onerror = () => toastr.error('Не удалось прочитать файл');
        reader.readAsText(file);
      });

      // Применить JSON из textarea
      document.getElementById('srt_import_apply')?.addEventListener('click', async () => {
        const raw = document.getElementById('srt_import_textarea')?.value?.trim();
        if (!raw) { toastr.warning('Вставьте JSON или выберите файл'); return; }
        try {
          const p = validateImport(JSON.parse(raw));
          await applyImport(p);
          toastr.success('✅ Импорт выполнен успешно');
        } catch (e) {
          toastr.error(`Ошибка импорта: ${e.message}`);
          const status = document.getElementById('srt_import_status');
          if (status) status.textContent = `❌ ${e.message}`;
        }
      });
    }, 0);
  }

  async function applyImport(p) {
    const { saveMetadata, chatMetadata } = ctx();
    const key = currentChatBoundKey();
    chatMetadata[key] = p;
    await saveMetadata();
    await saveBackup();
    await updateInjectedPrompt();
    await renderDrawer();
  }

  async function showPromptPreview() {
    const state = await getChatState();
    await ctx().Popup.show.text('Промпт SRT',
      `<pre style="white-space:pre-wrap;max-height:60vh;overflow:auto">${escapeHtml(buildPromptBlock(state))}</pre>`
    );
  }

  // ─── Settings panel ──────────────────────────────────────────────────────────

  async function mountSettingsUi() {
    if ($('#srt_settings_block').length) return;
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) { console.warn('[SRT] settings container not found'); return; }

    const s = getSettings();
    $(target).append(`
      <div class="srt-settings-block" id="srt_settings_block">
        <div class="srt-title">
          <span>🔐 Трекер секретов и раскрытий</span>
          <button type="button" id="srt_collapse_btn">▾</button>
        </div>
        <div class="srt-body">
          <div class="srt-row">
            <label class="checkbox_label"><input type="checkbox" id="srt_enabled" ${s.enabled ? 'checked' : ''}><span>Включить инъекцию в промпт</span></label>
          </div>
          <div class="srt-row">
            <label class="checkbox_label"><input type="checkbox" id="srt_show_widget" ${s.showWidget ? 'checked' : ''}><span>Показывать плавающий виджет 🔐</span></label>
          </div>
          <div class="srt-row">
            <label class="checkbox_label"><input type="checkbox" id="srt_autodetect" ${s.autoDetect ? 'checked' : ''}><span>Авто-детект раскрытий по маркеру [REVEAL:...]</span></label>
          </div>
          <div class="srt-row" style="gap:10px;align-items:center;">
            <label style="white-space:nowrap">Глубина сканирования:</label>
            <input type="range" id="srt_scan_depth" min="10" max="200" step="10" value="${s.scanDepth || 30}" style="flex:1;min-width:80px;">
            <span id="srt_scan_depth_display" style="min-width:30px;text-align:right">${s.scanDepth || 30}</span>
            <span>сообщ.</span>
          </div>

          <div class="srt-api-section">
            <div class="srt-api-title">⚙️ API для сканирования</div>
            <div class="srt-api-hint">Вставь endpoint (с /v1 или без — не важно), введи ключ, загрузи список моделей кнопкой 🔄 и нажми «Сканировать». Если оставить пустым — используется встроенный ST.</div>

            <span class="srt-api-label">Endpoint</span>
            <div class="srt-row">
              <input type="text" id="srt_api_endpoint" class="srt-api-field" placeholder="https://api.openai.com/v1" value="${escapeHtml(s.apiEndpoint || '')}">
            </div>

            <span class="srt-api-label">API Key</span>
            <div class="srt-row">
              <input type="password" id="srt_api_key" class="srt-api-field" placeholder="sk-..." value="${s.apiKey || ''}">
              <button type="button" id="srt_api_key_toggle" class="menu_button" style="padding:5px 10px;flex-shrink:0">👁</button>
            </div>

            <span class="srt-api-label">Модель</span>
            <div class="srt-row" style="gap:6px">
              <select id="srt_api_model_select" class="srt-api-select" style="flex:1">
                ${s.apiModel
                  ? `<option value="${escapeHtml(s.apiModel)}" selected>${escapeHtml(s.apiModel)}</option>`
                  : '<option value="">-- нажми 🔄 для загрузки --</option>'}
              </select>
              <button id="srt_refresh_models" class="menu_button" style="padding:5px 10px;flex-shrink:0" title="Загрузить список моделей">🔄</button>
            </div>

            <span class="srt-api-label">Персонаж</span>
            <div id="srt_char_preview" class="srt-char-preview">
              <img id="srt_char_avatar" src="" alt="" style="display:none">
              <span id="srt_char_name" style="font-size:12px;opacity:.7">(откройте чат с персонажем)</span>
            </div>

            <div class="srt-row" style="margin-top:8px">
              <button type="button" id="srt_api_test" class="menu_button" style="padding:5px 10px;flex-shrink:0">🧪 Тест соединения</button>
              <span id="srt_api_status" style="font-size:11px;opacity:0.75;flex:1"></span>
            </div>
          </div>

          <div class="srt-row srt-row-slim">
            <button class="menu_button" id="srt_open_drawer">Открыть трекер</button>
            <button class="menu_button" id="srt_scan_settings_btn">🔍 Сканировать чат</button>
            <button class="menu_button" id="srt_prompt_preview">Показать промпт</button>
            <button class="menu_button" id="srt_export_json">Экспорт</button>
            <button class="menu_button" id="srt_import_json">Импорт</button>
            <button class="menu_button" id="srt_reset_widget_pos">Сбросить позицию виджета</button>
          </div>
          <div class="srt-hint">
            <b>Как работает авто-режим:</b>
            <ul>
              <li>🔍 <b>Сканировать чат</b> — AI анализирует последние ~50 сообщений и сам предлагает секреты. Дубликаты не добавляются.</li>
              <li>⚡ <b>Авто-детект</b> — после каждого ответа {{char}} парсит маркер <code>[REVEAL: текст]</code> и автоматически помечает секрет как раскрытый.</li>
              <li>Данные хранятся отдельно для каждого чата (chat metadata).</li>
            </ul>
          </div>
        </div>
      </div>
    `);

    if (s.collapsed) { $('#srt_settings_block').addClass('srt-collapsed'); $('#srt_collapse_btn').text('▸'); }

    $('#srt_collapse_btn').on('click', () => {
      const now = !$('#srt_settings_block').hasClass('srt-collapsed');
      $('#srt_settings_block').toggleClass('srt-collapsed', now);
      $('#srt_collapse_btn').text(now ? '▸' : '▾');
      s.collapsed = now; ctx().saveSettingsDebounced();
    });

    $('#srt_enabled').on('input', async ev => { s.enabled = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); await updateInjectedPrompt(); });
    $('#srt_show_widget').on('input', async ev => { s.showWidget = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); await renderWidget(); });
    $('#srt_autodetect').on('input', ev => { s.autoDetect = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); });
    $('#srt_scan_depth').on('input', ev => {
      const val = parseInt($(ev.currentTarget).val(), 10);
      $('#srt_scan_depth_display').text(val);
      s.scanDepth = val;
      ctx().saveSettingsDebounced();
    });

    $('#srt_api_endpoint').on('input', () => { s.apiEndpoint = $('#srt_api_endpoint').val().trim(); ctx().saveSettingsDebounced(); });
    $('#srt_api_key').on('input',      () => { s.apiKey      = $('#srt_api_key').val().trim();      ctx().saveSettingsDebounced(); });

    $('#srt_api_key_toggle').on('click', () => {
      const inp = document.getElementById('srt_api_key');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    $('#srt_api_model_select').on('change', () => {
      s.apiModel = $('#srt_api_model_select').val();
      ctx().saveSettingsDebounced();
    });

    $('#srt_refresh_models').on('click', onRefreshModels);

    function updateCharPreview() {
      const c = ctx();
      try {
        const char = c.characters?.[c.characterId];
        if (!char) return;
        const $name   = $('#srt_char_name');
        const $avatar = $('#srt_char_avatar');
        $name.text(char.name || '');
        const av = char.avatar || char.data?.avatar;
        if (av && av !== 'none') {
          $avatar.attr('src', `/characters/${av}`).show()
            .on('error', function() { $(this).hide(); });
        } else {
          $avatar.hide();
        }
      } catch {}
    }
    updateCharPreview();

    $(document)
      .off('click.srt_settings')
      .on('click.srt_settings', '#srt_open_drawer',       () => openDrawer(true))
      .on('click.srt_settings', '#srt_scan_settings_btn', () => scanChatForSecrets())
      .on('click.srt_settings', '#srt_api_test', async () => {
        const $status = $('#srt_api_status');
        const $btn    = $('#srt_api_test');
        $btn.prop('disabled', true).text('⏳');
        $status.css('color', '').text('Проверяем…');
        try {
          const models = await fetchModelsForSelect();
          $status.css('color', '#2ecc71').text(`✅ Соединение OK · моделей: ${models.length}`);
          toastr.success(`API работает, доступно моделей: ${models.length}`);
        } catch (e) {
          $status.css('color', '#e74c3c').text(`❌ ${e.message}`);
          toastr.error(`[SRT] Тест API: ${e.message}`);
        } finally {
          $btn.prop('disabled', false).text('🧪 Тест соединения');
        }
      })
      .on('click.srt_settings', '#srt_prompt_preview', () => showPromptPreview())
      .on('click.srt_settings', '#srt_export_json',    () => exportJson())
      .on('click.srt_settings', '#srt_import_json',    () => importJson())
      .on('click.srt_settings', '#srt_reset_widget_pos', () => {
        try { localStorage.removeItem(FAB_POS_KEY); } catch {}
        setFabDefaultPosition();
        toastr.success('Позиция сброшена');
      });
  }

  // ─── Event wiring ────────────────────────────────────────────────────────────

  function wireChatEvents() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.APP_READY, async () => {
      ensureFab(); applyFabPosition(); ensureDrawer();
      await mountSettingsUi();
      await updateInjectedPrompt();
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
      await updateInjectedPrompt();
      if ($('#srt_drawer').hasClass('srt-open')) renderDrawer();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, async (idx) => {
      const { chat } = ctx();
      const msg = chat?.[idx];
      if (!msg || msg.is_user) return;
      await detectRevealInMessage(msg.mes || '');
      await renderWidget();
    });
  }

  // ─── Boot ────────────────────────────────────────────────────────────────────

  jQuery(() => {
    try { wireChatEvents(); console.log('[SRT] v0.5.4 loaded'); }
    catch (e) { console.error('[SRT] init failed', e); }
  });

})();
