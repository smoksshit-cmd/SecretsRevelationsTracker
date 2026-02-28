/**
 * Secrets & Revelations Tracker (SillyTavern Extension)
 * v0.5.0 — Auto-scan chat for secrets + live reveal detection
 *
 * New features:
 *  - "Сканировать чат" — AI анализирует историю чата и предлагает секреты
 *  - Авто-детект раскрытий — после каждого сообщения {{char}} проверяет, не открылась ли тайна
 *  - Инжектированный промпт явно просит модель сигнализировать [REVEAL:...] при раскрытии
 */

(() => {
  'use strict';

  const MODULE_KEY = 'secrets_revelations_tracker';
  const CHAT_KEY   = 'srt_state_v1';
  const PROMPT_TAG = 'SRT_SECRETS_TRACKER';
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
    autoDetect:   true,   // авто-детект раскрытий после каждого сообщения
    position:     EXT_PROMPT_TYPES.IN_PROMPT,
    depth:        0,
  });

  // ─── helpers ────────────────────────────────────────────────────────────────

  function ctx() { return SillyTavern.getContext(); }

  function getSettings() {
    const { extensionSettings, saveSettingsDebounced } = ctx();
    if (!extensionSettings[MODULE_KEY])
      extensionSettings[MODULE_KEY] = structuredClone(defaultSettings);
    for (const k of Object.keys(defaultSettings))
      if (!Object.hasOwn(extensionSettings[MODULE_KEY], k))
        extensionSettings[MODULE_KEY][k] = defaultSettings[k];
    return extensionSettings[MODULE_KEY];
  }

  async function getChatState() {
    const { chatMetadata, saveMetadata } = ctx();
    if (!chatMetadata[CHAT_KEY]) {
      chatMetadata[CHAT_KEY] = {
        npcLabel:      '{{char}}',
        npcSecrets:    [],
        userSecrets:   [],
        mutualSecrets: [],
      };
      await saveMetadata();
    }
    return chatMetadata[CHAT_KEY];
  }

  function makeId()       { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`; }
  function clamp(v,mn,mx){ return Math.max(mn, Math.min(mx, v)); }
  function clamp01(v)    { return Math.max(0, Math.min(1, v)); }

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
    return items.reduce((s,it) => s + (it.tag === 'kompromat' || it.tag === 'dangerous' ? 2 : it.tag === 'personal' ? 1 : 0), 0);
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

  // ─── generateRaw wrapper (works across ST versions) ─────────────────────────

  async function stGenerate(userPrompt, systemPrompt) {
    const c = ctx();
    // ST ≥ 1.11 exposes generateRaw
    if (typeof c.generateRaw === 'function') {
      try {
        return await c.generateRaw(userPrompt, null, false, false, systemPrompt, true);
      } catch (e) {
        console.warn('[SRT] generateRaw failed, falling back', e);
      }
    }
    // Fallback: use /api/backends/... — ST has no stable raw endpoint,
    // so we proxy through the extension's context generate
    if (typeof c.Generate === 'function') {
      return await c.Generate('quiet');
    }
    throw new Error('No generate function available in SillyTavern context');
  }

  // ─── PROMPT BLOCK ────────────────────────────────────────────────────────────

  function buildPromptBlock(state) {
    const npcKnownToUser   = state.npcSecrets.filter(s =>  s.knownToUser);
    const npcHiddenFromUser= state.npcSecrets.filter(s => !s.knownToUser);
    const userKnownToNpc   = state.userSecrets.filter(s =>  s.knownToNpc);

    const revealed = npcKnownToUser.length + state.userSecrets.length + state.mutualSecrets.length;
    const hidden   = npcHiddenFromUser.length;

    const fmt = arr => formatList(arr.map(s => `${s.text}${TAGS[s.tag]?.icon ? ' '+TAGS[s.tag].icon : ''}`));

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

  // ─── AUTO-SCAN: extract secrets from chat history ───────────────────────────

  async function scanChatForSecrets() {
    if (scanInProgress) return toastr.warning('[SRT] Сканирование уже идёт…');
    const history = getRecentMessages(50);
    if (!history) return toastr.warning('[SRT] История чата пуста');

    scanInProgress = true;
    const $btn = $('#srt_scan_btn');
    $btn.prop('disabled', true).text('⏳ Анализ…');

    try {
      const system = `Ты аналитик RP-диалогов. Твоя задача — извлечь секреты, тайны и скрытую информацию из диалога.
Верни ТОЛЬКО валидный JSON и ничего больше. Без преамбулы, без markdown-блоков.
Формат:
{
  "npcSecrets": [
    {"text": "описание секрета {{char}}", "tag": "none|dangerous|personal|kompromat", "knownToUser": true|false}
  ],
  "userSecrets": [
    {"text": "описание секрета {{user}}", "tag": "none|dangerous|personal|kompromat", "knownToNpc": true|false}
  ],
  "mutualSecrets": [
    {"text": "описание общего секрета", "tag": "none|dangerous|personal|kompromat"}
  ]
}
Правила:
- knownToUser/knownToNpc = true если в диалоге явно видно, что персонаж об этом узнал
- tag: dangerous — может навредить, personal — эмоциональный/личный, kompromat — рычаг давления
- Если ничего не найдено — верни пустые массивы
- НЕ добавляй секреты, которых нет в тексте`;

      const user = `Вот последние сообщения RP-чата:\n\n${history}\n\nИзвлеки все секреты, тайны и скрытую информацию.`;

      const raw = await stGenerate(user, system);
      if (!raw) throw new Error('Пустой ответ от модели');

      // Strip markdown fences if model added them
      const clean = raw.replace(/```json|```/gi, '').trim();
      const parsed = JSON.parse(clean);

      const state = await getChatState();
      const { saveMetadata } = ctx();

      let addedNpc = 0, addedUser = 0, addedMutual = 0;

      // Merge — avoid exact-text duplicates
      const existingTexts = new Set([
        ...state.npcSecrets.map(s => s.text.toLowerCase()),
        ...state.userSecrets.map(s => s.text.toLowerCase()),
        ...state.mutualSecrets.map(s => s.text.toLowerCase()),
      ]);

      for (const it of (parsed.npcSecrets || [])) {
        if (!it.text || existingTexts.has(it.text.toLowerCase())) continue;
        state.npcSecrets.unshift({ id: makeId(), text: it.text, tag: it.tag || 'none', knownToUser: !!it.knownToUser });
        existingTexts.add(it.text.toLowerCase());
        addedNpc++;
      }
      for (const it of (parsed.userSecrets || [])) {
        if (!it.text || existingTexts.has(it.text.toLowerCase())) continue;
        state.userSecrets.unshift({ id: makeId(), text: it.text, tag: it.tag || 'none', knownToNpc: !!it.knownToNpc });
        existingTexts.add(it.text.toLowerCase());
        addedUser++;
      }
      for (const it of (parsed.mutualSecrets || [])) {
        if (!it.text || existingTexts.has(it.text.toLowerCase())) continue;
        state.mutualSecrets.unshift({ id: makeId(), text: it.text, tag: it.tag || 'none' });
        existingTexts.add(it.text.toLowerCase());
        addedMutual++;
      }

      const added = addedNpc + addedUser + addedMutual;

      await saveMetadata();
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
      toastr.error(`[SRT] Ошибка анализа: ${e.message}`);
    } finally {
      scanInProgress = false;
      $btn.prop('disabled', false).text('🔍 Сканировать чат');
    }
  }

  // ─── AUTO-DETECT reveals in new messages ────────────────────────────────────

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

      // Try to match to an existing hidden {{char}} secret
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
        // New secret revealed — add to npcSecrets as known
        state.npcSecrets.unshift({ id: makeId(), text: revealedText, tag: 'none', knownToUser: true });
        changed = true;
        toastr.info(`🔓 Новый раскрытый секрет: «${revealedText}»`, 'SRT Авто-детект', { timeOut: 5000 });
      }
    }

    if (changed) {
      await saveMetadata();
      await updateInjectedPrompt();
      if ($('#srt_drawer').hasClass('open')) renderDrawer();
    }
  }

  // ─── FAB widget ──────────────────────────────────────────────────────────────

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

  function applyFabPosition() {
    const el = document.getElementById('srt_fab');
    if (!el) return;
    el.style.transform = 'none';
    try {
      const raw = localStorage.getItem(FAB_POS_KEY);
      if (!raw) { setFabDefaultPosition(); return; }
      const pos = JSON.parse(raw);
      if (!pos || typeof pos.x !== 'number') { setFabDefaultPosition(); return; }
      const rect = el.getBoundingClientRect();
      const w = window.innerWidth, h = window.innerHeight;
      const W = rect.width || 60, H = rect.height || 60;
      el.style.left   = clamp(Math.round(pos.x * (w - W)), FAB_MARGIN, w - W - FAB_MARGIN) + 'px';
      el.style.top    = clamp(Math.round(pos.y * (h - H)), FAB_MARGIN, h - H - FAB_MARGIN) + 'px';
      el.style.right  = 'auto';
      el.style.bottom = 'auto';
    } catch { setFabDefaultPosition(); }
  }

  function saveFabPositionPx(left, top) {
    const el = document.getElementById('srt_fab');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = window.innerWidth, h = window.innerHeight;
    const W = rect.width || 60, H = rect.height || 60;
    try { localStorage.setItem(FAB_POS_KEY, JSON.stringify({ x: clamp01(left / (w - W)), y: clamp01(top / (h - H)) })); } catch {}
  }

  function setFabDefaultPosition() {
    const el = document.getElementById('srt_fab');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const W = rect.width || 60, H = rect.height || 60;
    const left = window.innerWidth - W - FAB_MARGIN;
    const top  = (window.innerHeight - H) / 2;
    el.style.left   = clamp(left, FAB_MARGIN, window.innerWidth  - W - FAB_MARGIN) + 'px';
    el.style.top    = clamp(top,  FAB_MARGIN, window.innerHeight - H - FAB_MARGIN) + 'px';
    el.style.right  = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'none';
    saveFabPositionPx(parseInt(el.style.left) || 0, parseInt(el.style.top) || 0);
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
      const rect = fab.getBoundingClientRect();
      const w = window.innerWidth, h = window.innerHeight;
      fab.style.left   = clamp(sl + dx, FAB_MARGIN, w - rect.width  - FAB_MARGIN) + 'px';
      fab.style.top    = clamp(st + dy, FAB_MARGIN, h - rect.height - FAB_MARGIN) + 'px';
      fab.style.right  = 'auto'; fab.style.bottom = 'auto';
      ev.preventDefault(); ev.stopPropagation();
    };

    const onEnd = (ev) => {
      try { handle.releasePointerCapture(ev.pointerId); } catch {}
      document.removeEventListener('pointermove', onMove, { passive: false });
      document.removeEventListener('pointerup',   onEnd,  { passive: true });
      document.removeEventListener('pointercancel',onEnd, { passive: true });
      if (moved) { saveFabPositionPx(parseInt(fab.style.left)||0, parseInt(fab.style.top)||0); lastFabDragTs = Date.now(); }
      moved = false;
      fab.classList.remove('srt-dragging');
    };

    handle.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const rect = fab.getBoundingClientRect();
      const w = window.innerWidth, h = window.innerHeight;
      fab.style.left   = clamp(rect.left, FAB_MARGIN, w - rect.width  - FAB_MARGIN) + 'px';
      fab.style.top    = clamp(rect.top,  FAB_MARGIN, h - rect.height - FAB_MARGIN) + 'px';
      fab.style.right  = 'auto'; fab.style.bottom = 'auto'; fab.style.transform = 'none';
      sx = ev.clientX; sy = ev.clientY;
      sl = parseInt(fab.style.left)||0; st = parseInt(fab.style.top)||0;
      moved = false;
      try { handle.setPointerCapture(ev.pointerId); } catch {}
      document.addEventListener('pointermove', onMove, { passive: false });
      document.addEventListener('pointerup',   onEnd,  { passive: true });
      document.addEventListener('pointercancel',onEnd, { passive: true });
      ev.preventDefault(); ev.stopPropagation();
    }, { passive: false });

    let resizeT = null;
    window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(applyFabPosition, 120); });
  }

  // ─── DRAWER ──────────────────────────────────────────────────────────────────

  function ensureDrawer() {
    if ($('#srt_drawer').length) return;
    $('body').append(`
      <aside id="srt_drawer" aria-hidden="true">
        <header>
          <div class="topline">
            <div class="title">🔐 СЕКРЕТЫ И ТАЙНЫ</div>
            <button id="srt_close" title="Закрыть">✕</button>
          </div>
          <div class="sub" id="srt_subtitle"></div>
        </header>
        <div class="content" id="srt_content"></div>
        <div class="footer">
          <button id="srt_scan_btn">🔍 Сканировать чат</button>
          <button id="srt_quick_prompt">Промпт</button>
          <button id="srt_quick_export">Экспорт</button>
          <button id="srt_quick_import">Импорт</button>
          <button id="srt_close2">Закрыть</button>
        </div>
      </aside>
    `);
    $('#srt_close, #srt_close2').on('click', () => openDrawer(false));
    $('#srt_quick_prompt').on('click', showPromptPreview);
    $('#srt_quick_export').on('click', exportJson);
    $('#srt_quick_import').on('click', importJson);
    $('#srt_scan_btn').on('click', scanChatForSecrets);
  }

  function openDrawer(open) {
    ensureDrawer();
    const el = $('#srt_drawer');
    if (open) { el.addClass('open').attr('aria-hidden','false'); renderDrawer(); }
    else       { el.removeClass('open').attr('aria-hidden','true'); }
  }

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
      `<option value="${k}" ${k===selected?'selected':''}>${escapeHtml(TAGS[k].label)}</option>`
    ).join('');
  }

  function renderItemRow(item, kind) {
    const icon = TAGS[item.tag]?.icon ?? '';
    const toggle = kind === 'npc'
      ? `<label title="Известно {{user}}"><input type="checkbox" class="srt_toggle_known" data-kind="npc"  data-id="${item.id}" ${item.knownToUser?'checked':''}> 🔓</label>`
      : kind === 'user'
      ? `<label title="Известно {{char}}"><input type="checkbox" class="srt_toggle_known" data-kind="user" data-id="${item.id}" ${item.knownToNpc?'checked':''}> 🔓</label>`
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
    const state   = await getChatState();
    const npcName = getActiveNpcNameForUi();
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
            <input type="checkbox" id="srt_autodetect_cb" ${settings.autoDetect?'checked':''}> Авто-детект
          </label>
        </div>
        <div class="srt-scan-hint">
          Нажмите <b>🔍 Сканировать чат</b> — AI сам найдёт секреты в истории переписки.
        </div>
      </div>

      <div class="section">
        <h4>📖 Секреты {{char}} <small>(🔓 = известно {{user}})</small></h4>
        <div class="list">
          ${state.npcSecrets.map(s => renderItemRow(s,'npc')).join('') || '<div class="item"><div class="txt muted">—</div></div>'}
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
          ${state.userSecrets.map(s => renderItemRow(s,'user')).join('') || '<div class="item"><div class="txt muted">—</div></div>'}
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
          ${state.mutualSecrets.map(s => renderItemRow(s,'mutual')).join('') || '<div class="item"><div class="txt muted">—</div></div>'}
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
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────────

  async function addSecret(kind) {
    const state = await getChatState();
    const { saveMetadata } = ctx();

    if (kind === 'npc') {
      const text = String($('#srt_add_npc_text').val() ?? '').trim();
      if (!text) return toastr.warning('Введите текст секрета');
      state.npcSecrets.unshift({ id: makeId(), text, tag: String($('#srt_add_npc_tag').val()||'none'), knownToUser: Boolean($('#srt_add_npc_known').prop('checked')) });
      $('#srt_add_npc_text').val(''); $('#srt_add_npc_known').prop('checked', false);
    } else if (kind === 'user') {
      const text = String($('#srt_add_user_text').val() ?? '').trim();
      if (!text) return toastr.warning('Введите текст секрета');
      state.userSecrets.unshift({ id: makeId(), text, tag: String($('#srt_add_user_tag').val()||'none'), knownToNpc: Boolean($('#srt_add_user_known').prop('checked')) });
      $('#srt_add_user_text').val(''); $('#srt_add_user_known').prop('checked', false);
    } else {
      const text = String($('#srt_add_mutual_text').val() ?? '').trim();
      if (!text) return toastr.warning('Введите текст секрета');
      state.mutualSecrets.unshift({ id: makeId(), text, tag: String($('#srt_add_mutual_tag').val()||'none') });
      $('#srt_add_mutual_text').val('');
    }

    await saveMetadata();
    await updateInjectedPrompt();
    await renderDrawer();
  }

  async function deleteSecret(kind, id) {
    const state = await getChatState();
    const list = kind === 'npc' ? state.npcSecrets : kind === 'user' ? state.userSecrets : state.mutualSecrets;
    const idx = list.findIndex(x => x.id === id);
    if (idx >= 0) list.splice(idx, 1);
    await ctx().saveMetadata();
    await updateInjectedPrompt();
    await renderDrawer();
  }

  async function toggleKnown(kind, id, value) {
    const state = await getChatState();
    if (kind === 'npc') { const it = state.npcSecrets.find(x => x.id === id); if (it) it.knownToUser = value; }
    if (kind === 'user') { const it = state.userSecrets.find(x => x.id === id); if (it) it.knownToNpc = value; }
    await ctx().saveMetadata();
    await updateInjectedPrompt();
  }

  // ─── Import / Export / Prompt preview ───────────────────────────────────────

  async function exportJson() {
    const state = await getChatState();
    await ctx().Popup.show.text('Экспорт SRT', `<pre style="white-space:pre-wrap">${escapeHtml(JSON.stringify(state,null,2))}</pre>`);
  }

  async function showPromptPreview() {
    const state = await getChatState();
    await ctx().Popup.show.text('Промпт SRT', `<pre style="white-space:pre-wrap;max-height:60vh;overflow:auto">${escapeHtml(buildPromptBlock(state))}</pre>`);
  }

  async function importJson() {
    const { Popup, saveMetadata, chatMetadata } = ctx();
    const raw = await Popup.show.input('Импорт SRT', 'Вставьте JSON:', '');
    if (!raw) return;
    try {
      const p = JSON.parse(raw);
      if (!p || typeof p !== 'object') throw new Error('Not an object');
      p.npcSecrets    = Array.isArray(p.npcSecrets)    ? p.npcSecrets    : [];
      p.userSecrets   = Array.isArray(p.userSecrets)   ? p.userSecrets   : [];
      p.mutualSecrets = Array.isArray(p.mutualSecrets) ? p.mutualSecrets : [];
      p.npcLabel      = typeof p.npcLabel === 'string' ? p.npcLabel      : '{{char}}';
      chatMetadata[CHAT_KEY] = p;
      await saveMetadata();
      await updateInjectedPrompt();
      toastr.success('Импортировано');
      renderDrawer();
    } catch (e) { console.error('[SRT] import failed', e); toastr.error('Неверный JSON'); }
  }

  // ─── Settings panel ──────────────────────────────────────────────────────────

  async function mountSettingsUi() {
    if ($('#srt_enabled').length) return;
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
            <label class="checkbox_label"><input type="checkbox" id="srt_enabled" ${s.enabled?'checked':''}><span>Включить инъекцию в промпт</span></label>
          </div>
          <div class="srt-row">
            <label class="checkbox_label"><input type="checkbox" id="srt_show_widget" ${s.showWidget?'checked':''}><span>Показывать плавающий виджет 🔐</span></label>
          </div>
          <div class="srt-row">
            <label class="checkbox_label"><input type="checkbox" id="srt_autodetect" ${s.autoDetect?'checked':''}><span>Авто-детект раскрытий по маркеру [REVEAL:...]</span></label>
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

    $('#srt_open_drawer').on('click', () => openDrawer(true));
    $('#srt_scan_settings_btn').on('click', scanChatForSecrets);
    $('#srt_prompt_preview').on('click', showPromptPreview);
    $('#srt_export_json').on('click', exportJson);
    $('#srt_import_json').on('click', importJson);
    $('#srt_reset_widget_pos').on('click', () => {
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
      if ($('#srt_drawer').hasClass('open')) renderDrawer();
    });

    // After {{char}} replies — check for [REVEAL:...] markers
    eventSource.on(event_types.MESSAGE_RECEIVED, async (idx) => {
      const { chat } = ctx();
      const msg = chat?.[idx];
      if (!msg || msg.is_user) return;  // только {{char}}
      await detectRevealInMessage(msg.mes || '');
      await renderWidget(); // refresh counts
    });
  }

  // ─── Boot ────────────────────────────────────────────────────────────────────

  jQuery(() => {
    try { wireChatEvents(); console.log('[SRT] v0.5.0 loaded'); }
    catch (e) { console.error('[SRT] init failed', e); }
  });

})();
