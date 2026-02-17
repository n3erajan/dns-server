const api = {
  /**
   * Calls the dashboard API and unwraps the JSON body
   * @param {string} path - Path under /api
   * @param {Object} [options] - fetch options, body is JSON encoded when present
   * @returns {Promise<Object>} Parsed response body
   * @throws {Error} With .field and .status attached from the error response
   */
  async request(path, options = {}) {
    const { body, ...rest } = options
    const response = await fetch(`/api${path}`, {
      ...rest,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })

    const payload = await response.json().catch(() => ({}))

    if (!response.ok) {
      const error = new Error(
        payload.error || `Request failed (${response.status})`,
      )
      error.field = payload.field
      error.status = response.status
      throw error
    }

    return payload
  },
}

const state = {
  view: 'records',
  search: '',
  typeFilter: '',
  types: ['A', 'AAAA', 'CNAME', 'MX', 'TXT'],
  records: [],
  recordStats: { domains: 0, records: 0 },
  // Row being edited as "name|type", or 'new' for the add row
  editing: null,
  blocklist: { domains: [], total: 0, page: 1, pages: 1, active: 0 },
  loading: true,
}

const $ = (selector) => document.querySelector(selector)
const el = {
  recordsBody: $('[data-records-body]'),
  recordsSub: $('[data-records-sub]'),
  blocklistBody: $('[data-blocklist-body]'),
  blocklistSub: $('[data-blocklist-sub]'),
  blockInput: $('[data-block-input]'),
  blockError: $('[data-block-error]'),
  search: $('[data-search]'),
  typeFilter: $('[data-type-filter]'),
  banner: $('[data-banner]'),
  bannerText: $('[data-banner-text]'),
  pagination: $('[data-pagination]'),
  paginationInfo: $('[data-pagination-info]'),
  modal: $('[data-modal]'),
  modalMessage: $('[data-modal-message]'),
  modalTarget: $('[data-modal-target]'),
  modalConfirm: $('[data-modal-confirm]'),
  toasts: $('[data-toasts]'),
  status: $('[data-status]'),
  statusText: $('[data-status-text]'),
}

const ICONS = {
  success:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20h4l10-10-4-4L4 16v4zM14 6l4 4"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
}

/**
 * Escapes text for safe insertion into innerHTML
 * @param {*} value - Any value to render as text
 * @returns {string} HTML escaped string
 */
const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/**
 * Shows a transient toast
 * @param {string} message - Text to display
 * @param {'success'|'error'} [variant] - Visual variant
 */
const toast = (message, variant = 'success') => {
  const node = document.createElement('div')
  node.className = 'toast'
  node.dataset.variant = variant
  node.innerHTML = `${ICONS[variant]}<span>${escapeHtml(message)}</span>`
  el.toasts.append(node)

  setTimeout(
    () => {
      node.classList.add('is-leaving')
      node.addEventListener('animationend', () => node.remove(), { once: true })
    },
    variant === 'error' ? 5000 : 3000,
  )
}

/**
 * Shows or hides the connection banner
 * @param {string|null} message - Message to show, or null to hide
 */
const setBanner = (message) => {
  el.banner.hidden = !message
  el.bannerText.textContent = message ?? ''
  el.status.dataset.state = message ? 'down' : 'up'
  el.statusText.textContent = message ? 'Disconnected' : 'Connected'
}

/**
 * Formats a record's content array for the table
 * @param {string} type - Record type
 * @param {Array} content - Content values
 * @returns {string} HTML with one line per value
 */
const formatContent = (type, content) => {
  const values = (content ?? []).map((value) => {
    if (type === 'MX' && value && typeof value === 'object') {
      return `${value.preference} ${value.exchange}`
    }
    return value
  })

  return values.map((value) => `<div>${escapeHtml(value)}</div>`).join('')
}

/**
 * Converts a content array back into textarea text for editing
 * @param {string} type - Record type
 * @param {Array} content - Content values
 * @returns {string} One value per line
 */
const contentToText = (type, content) =>
  (content ?? [])
    .map((value) =>
      type === 'MX' && value && typeof value === 'object'
        ? `${value.preference} ${value.exchange}`
        : value,
    )
    .join('\n')

const CONTENT_HINTS = {
  A: 'One IPv4 address per line',
  AAAA: 'One IPv6 address per line',
  CNAME: 'A single target domain',
  TXT: 'One value per line, commas are kept',
}

const CONTENT_PLACEHOLDERS = {
  A: '192.168.1.100',
  AAAA: 'fe80::b834:fcfd:35e:bd6c',
  CNAME: 'app.example.com',
  TXT: 'v=spf1 ip4:192.168.16.51 ~all',
}

/**
 * Grows a textarea to fit its content, so no resize grip is needed
 * @param {HTMLTextAreaElement} node - Textarea to resize
 */
const autoGrow = (node) => {
  if (!node) return
  node.style.height = 'auto'
  node.style.height = `${Math.min(node.scrollHeight, 260)}px`
}

/**
 * Builds one MX priority and mail server pair
 * @param {Object} [value] - Existing MX value
 * @returns {string} Row HTML
 */
const renderMxRow = (value = {}) => `
  <div class="mx-row" data-mx-row>
    <input
      class="input"
      data-mx-preference
      value="${escapeHtml(value.preference ?? '')}"
      placeholder="10"
      inputmode="numeric"
      autocomplete="off"
      aria-label="Priority"
    />
    <input
      class="input"
      data-mx-exchange
      value="${escapeHtml(value.exchange ?? '')}"
      placeholder="mail.example.com"
      spellcheck="false"
      autocomplete="off"
      aria-label="Mail server"
    />
    <button class="btn btn-icon btn-ghost btn-danger" type="button" data-mx-remove aria-label="Remove mail server">${ICONS.trash}</button>
  </div>
`

/**
 * Builds the content column for a record type
 * MX gets a separate numeric priority per mail server, everything else is text
 * @param {string} type - Record type
 * @param {Object|null} record - Record being edited, or null when adding
 * @returns {string} Label plus field HTML
 */
const renderContentField = (type, record) => {
  if (type === 'MX') {
    const values = (record?.content ?? []).filter(
      (value) => value && typeof value === 'object',
    )
    const rows = values.length ? values : [{}]

    return `
      <div class="mx-row mx-head">
        <span class="editor-label">Priority</span>
        <span class="editor-label">Mail server</span>
        <span></span>
      </div>
      <div class="mx-rows" data-mx-rows>${rows.map(renderMxRow).join('')}</div>
      <button class="btn btn-ghost mx-add" type="button" data-mx-add>+ Add mail server</button>
    `
  }

  return `
    <label class="editor-label" for="editor-content">Content</label>
    <textarea
      class="textarea"
      id="editor-content"
      data-editor-content
      rows="1"
      placeholder="${escapeHtml(CONTENT_PLACEHOLDERS[type])}"
      spellcheck="false"
    >${escapeHtml(contentToText(type, record?.content))}</textarea>
    <div class="editor-hint">${escapeHtml(CONTENT_HINTS[type])}</div>
  `
}

/**
 * Reads the content value out of the open editor
 * @param {string} type - Record type
 * @returns {string|Array} Textarea text, or MX objects
 */
const collectContent = (type) => {
  if (type !== 'MX') return $('[data-editor-content]')?.value ?? ''

  return (
    [...document.querySelectorAll('[data-mx-row]')]
      .map((row) => ({
        preference: row.querySelector('[data-mx-preference]').value.trim(),
        exchange: row.querySelector('[data-mx-exchange]').value.trim(),
      }))
      // Drop fully blank rows, keep half filled ones so they report an error
      .filter((value) => value.preference !== '' || value.exchange !== '')
  )
}

/**
 * Builds the inline add/edit editor row
 * @param {Object|null} record - Record being edited, or null when adding
 * @returns {string} Table row HTML
 */
const renderEditor = (record) => {
  const isNew = !record
  const type = record?.type ?? 'A'
  const typeOptions = state.types
    .map(
      (value) =>
        `<option value="${value}"${value === type ? ' selected' : ''}>${value}</option>`,
    )
    .join('')

  return `
    <tr class="editor-row">
      <td colspan="5">
        <div class="editor" data-editor>
          <div class="editor-field">
            <label class="editor-label" for="editor-type">Type</label>
            <select class="select" id="editor-type" data-editor-type ${isNew ? '' : 'disabled'}>
              ${typeOptions}
            </select>
          </div>
          <div class="editor-field">
            <label class="editor-label" for="editor-name">Name</label>
            <input
              class="input"
              id="editor-name"
              data-editor-name
              value="${escapeHtml(record?.name ?? '')}"
              placeholder="myapp.local"
              ${isNew ? '' : 'readonly'}
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <div class="editor-field" data-content-wrap>
            ${renderContentField(type, record)}
          </div>
          <div class="editor-field">
            <label class="editor-label" for="editor-ttl">TTL</label>
            <input
              class="input"
              id="editor-ttl"
              data-editor-ttl
              value="${record?.ttl ?? ''}"
              placeholder="Auto"
              inputmode="numeric"
              autocomplete="off"
            />
          </div>
          <div class="editor-actions">
            <button class="btn btn-primary" type="button" data-editor-save>Save</button>
            <button class="btn" type="button" data-editor-cancel>Cancel</button>
          </div>
          <div class="editor-field" style="grid-column: 1 / -1">
            <div class="field-error" data-editor-error hidden></div>
          </div>
        </div>
      </td>
    </tr>
  `
}

/**
 * Renders the records table, including the inline editor when open
 */
const renderRecords = () => {
  // Any open popup belongs to a button this render is about to destroy
  closeSelect()
  const rows = []

  if (state.editing === 'new') rows.push(renderEditor(null))

  for (const record of state.records) {
    const key = `${record.name}|${record.type}`

    if (state.editing === key) {
      rows.push(renderEditor(record))
      continue
    }

    rows.push(`
      <tr>
        <td data-label="Type"><span class="badge">${escapeHtml(record.type)}</span></td>
        <td class="cell-name" data-label="Name">${escapeHtml(record.name)}</td>
        <td class="cell-content mono" data-label="Content">${formatContent(record.type, record.content)}</td>
        <td class="cell-ttl" data-label="TTL">${record.ttl ?? 'Auto'}</td>
        <td class="col-actions">
          <div class="row-actions">
            <button class="btn btn-icon btn-ghost" type="button" data-edit="${escapeHtml(key)}" aria-label="Edit ${escapeHtml(record.type)} record for ${escapeHtml(record.name)}">${ICONS.edit}</button>
            <button class="btn btn-icon btn-ghost btn-danger" type="button" data-delete="${escapeHtml(key)}" aria-label="Delete ${escapeHtml(record.type)} record for ${escapeHtml(record.name)}">${ICONS.trash}</button>
          </div>
        </td>
      </tr>
    `)
  }

  if (rows.length === 0) {
    const isFiltered = state.search || state.typeFilter
    rows.push(`
      <tr>
        <td colspan="5">
          <div class="empty">
            <div class="empty-title">${isFiltered ? 'No matching records' : 'No records yet'}</div>
            <p>${
              isFiltered
                ? 'Try a different search or type filter.'
                : 'Add a record to point a domain at an address on your network.'
            }</p>
          </div>
        </td>
      </tr>
    `)
  }

  el.recordsBody.innerHTML = rows.join('')
  // The editor row may have just introduced a fresh type select
  enhanceSelects()

  const { domains, records } = state.recordStats
  el.recordsSub.textContent =
    records === 0
      ? 'No records configured yet. Add a record to get started.'
      : `${records} ${records === 1 ? 'record' : 'records'} across ${domains} ${domains === 1 ? 'domain' : 'domains'}`

  $('[data-count="records"]').textContent = records || ''

  // Focus the first field so the editor is usable straight from the keyboard
  if (state.editing) {
    const editor = $('[data-editor]')
    autoGrow($('[data-editor-content]'))

    const field =
      state.editing === 'new'
        ? $('[data-editor-name]')
        : editor?.querySelector('[data-editor-content], [data-mx-preference]')
    field?.focus()
  }
}

/**
 * Renders the blocklist page
 */
const renderBlocklist = () => {
  const { domains, total, page, pages, active } = state.blocklist

  el.blocklistBody.innerHTML =
    domains.length === 0
      ? `<li><div class="empty" style="width: 100%">
           <div class="empty-title">${state.search ? 'No matching domains' : 'Nothing blocked yet'}</div>
           <p>${state.search ? 'Try a different search.' : 'Paste a list of domains above to start blocking them.'}</p>
         </div></li>`
      : domains
          .map(
            (domain) => `
        <li>
          <span class="domain-name mono">${escapeHtml(domain)}</span>
          <button class="btn btn-icon btn-ghost btn-danger" type="button" data-unblock="${escapeHtml(domain)}" aria-label="Unblock ${escapeHtml(domain)}">${ICONS.trash}</button>
        </li>
      `,
          )
          .join('')

  el.blocklistSub.textContent = `${active} ${active === 1 ? 'domain' : 'domains'} active in memory. Changes apply immediately, no restart.`
  // active is the in-memory total, so the count stays honest while searching
  $('[data-count="blocklist"]').textContent = active || ''

  el.pagination.hidden = pages <= 1
  el.paginationInfo.textContent = `Page ${page} of ${pages} · ${total} total`
  $('[data-page-prev]').disabled = page <= 1
  $('[data-page-next]').disabled = page >= pages
}

/**
 * Loads records from the API and re-renders
 */
const loadRecords = async () => {
  const params = new URLSearchParams()
  if (state.search) params.set('q', state.search)
  if (state.typeFilter) params.set('type', state.typeFilter)

  const data = await api.request(`/records?${params}`)
  state.records = data.records
  state.recordStats = data.stats

  if (data.types?.length) {
    state.types = data.types
    // Populate once, the supported types don't change at runtime
    if (el.typeFilter.options.length === 1) {
      el.typeFilter.insertAdjacentHTML(
        'beforeend',
        data.types
          .map((type) => `<option value="${type}">${type}</option>`)
          .join(''),
      )
    }
  }

  renderRecords()
}

/**
 * Loads the blocklist page from the API and re-renders
 */
const loadBlocklist = async () => {
  const params = new URLSearchParams({ page: String(state.blocklist.page) })
  if (state.search) params.set('q', state.search)

  const data = await api.request(`/blocklist?${params}`)
  state.blocklist = { ...state.blocklist, ...data }
  renderBlocklist()
}

/**
 * Reloads whichever view is active, surfacing connection failures in the banner
 */
const refresh = async () => {
  try {
    if (state.view === 'records') await loadRecords()
    else await loadBlocklist()
    setBanner(null)
  } catch (error) {
    setBanner(error.message)
  }
}

/**
 * Fills in the blocklist count in the sidebar without switching views
 */
const loadBlocklistCount = async () => {
  try {
    const data = await api.request('/blocklist?limit=1')
    state.blocklist.active = data.active
    $('[data-count="blocklist"]').textContent = data.active || ''
  } catch {
    // The banner already reports connection problems from refresh()
  }
}

/**
 * Switches the active view
 * @param {string} view - 'records' or 'blocklist'
 */
const setView = (view) => {
  state.view = view
  state.editing = null
  state.search = ''
  state.blocklist.page = 1
  el.search.value = ''
  el.search.placeholder =
    view === 'records' ? 'Search domains' : 'Search blocked domains'

  for (const button of document.querySelectorAll('[data-view]')) {
    const isActive = button.dataset.view === view
    if (isActive) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }

  for (const panel of document.querySelectorAll('[data-view-panel]')) {
    panel.hidden = panel.dataset.viewPanel !== view
  }

  refresh()
}

/**
 * Opens the delete confirmation modal
 * @param {Object} params
 * @param {string} params.message - Plain prose question
 * @param {string} params.target - Record or domain the action applies to
 * @param {string} [params.action] - Label for the confirm button
 * @param {Function} onConfirm - Called when the user confirms
 */
const confirmDelete = ({ message, target, action = 'Delete' }, onConfirm) => {
  el.modalMessage.textContent = message
  el.modalTarget.textContent = target
  el.modalConfirm.textContent = action
  el.modal.hidden = false
  el.modalConfirm.focus()

  el.modal.dataset.pending = 'true'
  el.modal.onConfirmAction = onConfirm
}

const closeModal = () => {
  el.modal.hidden = true
  delete el.modal.dataset.pending
  el.modal.onConfirmAction = null
}

/**
 * Saves the open editor row, creating or updating as appropriate
 */
const saveEditor = async () => {
  const errorNode = $('[data-editor-error]')
  const nameInput = $('[data-editor-name]')
  const ttlInput = $('[data-editor-ttl]')
  const typeInput = $('[data-editor-type]')
  const saveButton = $('[data-editor-save]')

  const payload = {
    name: nameInput.value,
    type: typeInput.value,
    content: collectContent(typeInput.value),
    ttl: ttlInput.value.trim(),
  }

  // MX has no single content field, so the first priority input stands in for it
  const contentInput = $('[data-editor-content]') ?? $('[data-mx-preference]')

  errorNode.hidden = true
  for (const input of [nameInput, contentInput, ttlInput, typeInput]) {
    input?.removeAttribute('aria-invalid')
  }
  saveButton.disabled = true

  try {
    const isNew = state.editing === 'new'

    if (isNew) {
      await api.request('/records', { method: 'POST', body: payload })
    } else {
      const [name, type] = state.editing.split('|')
      await api.request(
        `/records/${encodeURIComponent(name)}/${encodeURIComponent(type)}`,
        {
          method: 'PATCH',
          body: { content: payload.content, ttl: payload.ttl },
        },
      )
    }

    state.editing = null
    await loadRecords()
    toast(
      isNew
        ? `Added ${payload.type} record for ${payload.name}`
        : 'Record updated',
    )
  } catch (error) {
    saveButton.disabled = false
    errorNode.textContent = error.message
    errorNode.hidden = false

    const fieldMap = {
      name: nameInput,
      type: typeInput,
      content: contentInput,
      ttl: ttlInput,
    }
    const target = fieldMap[error.field]
    if (target) {
      target.setAttribute('aria-invalid', 'true')
      target.focus()
    }
  }
}

/**
 * Submits the blocklist textarea
 */
const submitBlocklist = async () => {
  const button = $('[data-block-submit]')
  const domains = el.blockInput.value

  el.blockError.hidden = true
  el.blockInput.removeAttribute('aria-invalid')
  button.disabled = true

  try {
    const result = await api.request('/blocklist', {
      method: 'POST',
      body: { domains },
    })
    el.blockInput.value = ''

    const parts = []
    if (result.added) parts.push(`${result.added} blocked`)
    if (result.duplicates) parts.push(`${result.duplicates} already blocked`)
    if (result.invalid?.length) parts.push(`${result.invalid.length} invalid`)
    parts.push(`${result.active} active`)

    toast(parts.join(', '))
    state.blocklist.page = 1
    await loadBlocklist()
  } catch (error) {
    el.blockError.textContent = error.message
    el.blockError.hidden = false
    el.blockInput.setAttribute('aria-invalid', 'true')
  } finally {
    button.disabled = false
  }
}

/* ---------- custom select ---------- */

const CHEVRON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>'
const CHECK =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M13 4.5L6.5 11.5 3 8"/></svg>'

// Only one popup is ever open, tracked here so outside clicks can close it
let openSelect = null

const closeSelect = () => {
  if (!openSelect) return
  openSelect.popup.remove()
  openSelect.button.setAttribute('aria-expanded', 'false')
  openSelect = null
}

/**
 * Places the popup against its button, flipping above when there is no room below
 * @param {HTMLElement} button - Trigger button
 * @param {HTMLElement} popup - Popup element, already in the document
 */
const positionSelectPopup = (button, popup) => {
  const rect = button.getBoundingClientRect()
  popup.style.minWidth = `${rect.width}px`
  popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popup.offsetWidth - 8))}px`

  const spaceBelow = window.innerHeight - rect.bottom
  const flip =
    spaceBelow < popup.offsetHeight + 8 && rect.top > popup.offsetHeight + 8
  popup.style.top = flip
    ? `${rect.top - popup.offsetHeight - 4}px`
    : `${rect.bottom + 4}px`
}

/**
 * Marks one option as keyboard active
 * @param {number} index - Option index to activate
 * @param {boolean} [scroll] - Scroll it into view, skipped for hover so the
 *   list does not shift under the pointer
 */
const setActiveOption = (index, scroll = true) => {
  if (!openSelect) return
  const options = [...openSelect.popup.children]
  openSelect.activeIndex = Math.max(0, Math.min(index, options.length - 1))

  options.forEach((option, i) => {
    if (i === openSelect.activeIndex) {
      option.dataset.active = 'true'
      if (scroll) option.scrollIntoView({ block: 'nearest' })
    } else {
      delete option.dataset.active
    }
  })
}

/**
 * Commits a value to the underlying select and notifies existing listeners
 * @param {string} value - Option value to select
 */
const commitSelect = (value) => {
  if (!openSelect) return
  const { select, button } = openSelect

  select.value = value
  button.querySelector('[data-select-label]').textContent =
    select.options[select.selectedIndex]?.textContent ?? ''

  closeSelect()
  button.focus()
  // Existing change handlers read the native select, so reuse them
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

/**
 * Opens the popup for a given enhanced select
 * @param {HTMLSelectElement} select - Native select holding the options
 * @param {HTMLElement} button - Trigger button
 */
const openSelectPopup = (select, button) => {
  closeSelect()

  const popup = document.createElement('div')
  popup.className = 'select-popup'
  popup.setAttribute('role', 'listbox')
  popup.innerHTML = [...select.options]
    .map(
      (option) => `
      <button
        class="select-option"
        type="button"
        role="option"
        data-value="${escapeHtml(option.value)}"
        aria-selected="${option.value === select.value}"
      >${CHECK}<span>${escapeHtml(option.textContent)}</span></button>
    `,
    )
    .join('')

  document.body.append(popup)
  button.setAttribute('aria-expanded', 'true')

  openSelect = { select, button, popup, activeIndex: select.selectedIndex }
  positionSelectPopup(button, popup)
  setActiveOption(select.selectedIndex)

  popup.addEventListener('click', (event) => {
    const option = event.target.closest('.select-option')
    if (!option) return
    event.stopPropagation()
    commitSelect(option.dataset.value)
  })

  // Hover drives the same highlight as the arrow keys, so there is only ever
  // one highlighted option, the way a native select behaves
  popup.addEventListener('mouseover', (event) => {
    const option = event.target.closest('.select-option')
    if (!option) return
    setActiveOption([...popup.children].indexOf(option), false)
  })
}

/**
 * Replaces a native select with a themed button and listbox
 * Native option panels are drawn by the OS and cannot be styled
 * @param {HTMLSelectElement} select - Select to enhance
 */
const enhanceSelect = (select) => {
  if (select.dataset.enhanced) return
  select.dataset.enhanced = 'true'

  const wrap = document.createElement('div')
  wrap.className = 'select-wrap'

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'select-button'
  button.disabled = select.disabled
  button.setAttribute('aria-haspopup', 'listbox')
  button.setAttribute('aria-expanded', 'false')
  if (select.getAttribute('aria-label')) {
    button.setAttribute('aria-label', select.getAttribute('aria-label'))
  } else if (select.id) {
    // Move the visible label's association onto the button, since the native
    // select is now hidden and could not receive the focus a label click sends
    const label = document.querySelector(`label[for="${select.id}"]`)
    if (label) {
      button.setAttribute('aria-label', label.textContent.trim())
      label.removeAttribute('for')
    }
  }
  button.innerHTML = `<span data-select-label>${escapeHtml(
    select.options[select.selectedIndex]?.textContent ?? '',
  )}</span>${CHEVRON}`

  select.replaceWith(wrap)
  select.classList.add('select-native')
  select.classList.remove('select')
  wrap.append(select, button)

  button.addEventListener('click', (event) => {
    event.stopPropagation()
    if (openSelect?.button === button) closeSelect()
    else openSelectPopup(select, button)
  })

  button.addEventListener('keydown', (event) => {
    const isOpen = openSelect?.button === button

    if (event.key === 'Escape' && isOpen) {
      event.stopPropagation()
      closeSelect()
      return
    }

    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault()

      if (!isOpen) {
        openSelectPopup(select, button)
        return
      }

      if (event.key === 'Enter' || event.key === ' ') {
        commitSelect(
          openSelect.popup.children[openSelect.activeIndex].dataset.value,
        )
        return
      }

      setActiveOption(
        openSelect.activeIndex + (event.key === 'ArrowDown' ? 1 : -1),
      )
      return
    }

    if (isOpen && event.key === 'Home') {
      event.preventDefault()
      setActiveOption(0)
    }

    if (isOpen && event.key === 'End') {
      event.preventDefault()
      setActiveOption(openSelect.popup.children.length - 1)
    }

    if (event.key === 'Tab' && isOpen) closeSelect()
  })
}

/**
 * Enhances every select that hasn't been enhanced yet
 */
const enhanceSelects = () => {
  for (const select of document.querySelectorAll(
    'select:not([data-enhanced])',
  )) {
    enhanceSelect(select)
  }
}

document.addEventListener('mousedown', (event) => {
  if (!openSelect) return
  if (event.target.closest('.select-popup, .select-button')) return
  closeSelect()
})

window.addEventListener('resize', closeSelect)
// Reposition rather than close, the page scrolls under a fixed popup
document.addEventListener(
  'scroll',
  () => {
    if (openSelect) positionSelectPopup(openSelect.button, openSelect.popup)
  },
  true,
)

/* ---------- events ---------- */

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button')
  if (!target) return

  // Sidebar navigation
  if (target.dataset.view) {
    setView(target.dataset.view)
    return
  }

  // Theme toggle
  if (target.hasAttribute('data-theme-toggle')) {
    const isDark = document.documentElement.classList.toggle('dark')
    localStorage.setItem('dns-theme', isDark ? 'dark' : 'light')
    applyThemeLabel(isDark)
    return
  }

  // Records: open the add row
  if (target.hasAttribute('data-add-record')) {
    state.editing = 'new'
    renderRecords()
    return
  }

  // Records: open an edit row
  if (target.dataset.edit) {
    state.editing = target.dataset.edit
    renderRecords()
    return
  }

  if (target.hasAttribute('data-editor-cancel')) {
    state.editing = null
    renderRecords()
    return
  }

  if (target.hasAttribute('data-editor-save')) {
    await saveEditor()
    return
  }

  // MX: add another priority and mail server pair
  if (target.hasAttribute('data-mx-add')) {
    $('[data-mx-rows]').insertAdjacentHTML('beforeend', renderMxRow())
    $('[data-mx-rows]')
      .lastElementChild.querySelector('[data-mx-preference]')
      .focus()
    return
  }

  if (target.hasAttribute('data-mx-remove')) {
    const rows = $('[data-mx-rows]')
    // Always leave one row so there is somewhere to type
    if (rows.children.length > 1) target.closest('[data-mx-row]').remove()
    return
  }

  // Records: delete
  if (target.dataset.delete) {
    const [name, type] = target.dataset.delete.split('|')
    confirmDelete(
      {
        message: `Delete this ${type} record?`,
        target: name,
      },
      async () => {
        try {
          const result = await api.request(
            `/records/${encodeURIComponent(name)}/${encodeURIComponent(type)}`,
            { method: 'DELETE' },
          )
          await loadRecords()
          toast(
            result.domainRemoved
              ? `Deleted ${type} record, ${name} has no records left`
              : `Deleted ${type} record for ${name}`,
          )
        } catch (error) {
          toast(error.message, 'error')
        }
      },
    )
    return
  }

  // Blocklist: unblock
  if (target.dataset.unblock) {
    const domain = target.dataset.unblock
    confirmDelete(
      { message: 'Unblock this domain?', target: domain, action: 'Unblock' },
      async () => {
        try {
          const result = await api.request(
            `/blocklist/${encodeURIComponent(domain)}`,
            {
              method: 'DELETE',
            },
          )
          await loadBlocklist()
          toast(`Unblocked ${domain}, ${result.active} still active`)
        } catch (error) {
          toast(error.message, 'error')
        }
      },
    )
    return
  }

  if (target.hasAttribute('data-block-submit')) {
    await submitBlocklist()
    return
  }

  // Modal
  if (target.hasAttribute('data-modal-confirm')) {
    const action = el.modal.onConfirmAction
    closeModal()
    await action?.()
    return
  }

  if (target.hasAttribute('data-modal-cancel')) {
    closeModal()
    return
  }

  // Pagination
  if (target.hasAttribute('data-page-prev')) {
    state.blocklist.page = Math.max(1, state.blocklist.page - 1)
    await refresh()
    return
  }

  if (target.hasAttribute('data-page-next')) {
    state.blocklist.page = Math.min(
      state.blocklist.pages,
      state.blocklist.page + 1,
    )
    await refresh()
  }
})

// Close the modal on a backdrop click
el.modal.addEventListener('click', (event) => {
  if (event.target === el.modal) closeModal()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!el.modal.hidden) {
      closeModal()
      return
    }
    if (state.editing) {
      state.editing = null
      renderRecords()
    }
  }
})

// Submit the editor with Ctrl/Cmd + Enter from the content textarea
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return
  const editor = event.target.closest('[data-editor]')
  if (!editor) return

  const isTextarea = event.target.matches('[data-editor-content]')
  if (isTextarea && !(event.ctrlKey || event.metaKey)) return

  event.preventDefault()
  saveEditor()
})

// Rebuild the content column when the type changes, the formats differ per type
document.addEventListener('change', (event) => {
  if (event.target.matches('[data-editor-type]')) {
    const wrap = $('[data-content-wrap]')
    wrap.innerHTML = renderContentField(event.target.value, null)
    autoGrow($('[data-editor-content]'))
    wrap.querySelector('textarea, input')?.focus()
    return
  }

  if (event.target.matches('[data-type-filter]')) {
    state.typeFilter = event.target.value
    refresh()
  }
})

// Grow textareas as they fill instead of showing a resize grip
document.addEventListener('input', (event) => {
  if (event.target.matches('.textarea')) autoGrow(event.target)
})

let searchTimer
el.search.addEventListener('input', (event) => {
  state.search = event.target.value.trim()
  state.blocklist.page = 1
  clearTimeout(searchTimer)
  searchTimer = setTimeout(refresh, 200)
})

// Ctrl/Cmd + Enter submits the blocklist textarea
el.blockInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    submitBlocklist()
  }
})

/**
 * Syncs the theme toggle icon and label
 * @param {boolean} isDark - Whether dark mode is active
 */
const applyThemeLabel = (isDark) => {
  $('[data-theme-icon="dark"]').toggleAttribute('hidden', isDark)
  $('[data-theme-icon="light"]').toggleAttribute('hidden', !isDark)
  $('[data-theme-label]').textContent = isDark ? 'Light mode' : 'Dark mode'
}

const storedTheme = localStorage.getItem('dns-theme')
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
const startDark = storedTheme ? storedTheme === 'dark' : prefersDark
document.documentElement.classList.toggle('dark', startDark)
applyThemeLabel(startDark)

enhanceSelects()
refresh()
loadBlocklistCount()
