const {
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  SearchComponent,
  Setting,
  TFile,
  TFolder,
  setIcon,
} = require("obsidian");

const VIEW_TYPE_START_PAGE = "local-start-page-view";
const HISTORY_LIMIT = 40;
const TEMPORARY_FOLDER = "temporary";
const UNTITLED_NOTE_NAME = "Untitled";
const LOCAL_TRASH_FOLDER = "bin/local-home-page";
const LEGACY_LOCAL_TRASH_FOLDER = ".trash/local-home-page";
const DEFAULT_SETTINGS = {
  openOnStartup: true,
  replaceActiveLeafOnStartup: true,
  title: "Home",
  subtitle: "Search files and folders across your vault",
  maxRecent: 10,
  maxSearchResults: 12,
  defaultTab: "recent",
  pinnedItems: [],
  deletedItems: [],
  recentHistory: [],
  removedBookmarks: [],
  folderHistory: [],
  // Display section toggles
  showRecent: true,
  showDeleted: true,
  showPinned: true,
  showTasks: false,
  showTempNotes: true,
  showSearch: true,
  showVaultTree: true,
  showStats: true,
  showUpcoming: true,
  upcomingMaxItems: 6,
  showBookmarks: true,
  showFavorites: true,
  showGreeting: true,
  // Greeting
  tasksFilterQuery: "",
  maxTasks: 10,
  tasks: [],
  // Temporary notes folder
  tempFolder: TEMPORARY_FOLDER,
  // Compact ribbon menu (true = show popover menu, false = open full view)
  compactRibbonMenu: true,
  layoutPreset: "default",
  focusMode: false,
};

function normalizeStringHistory(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function normalizePinnedItems(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item.path !== "string") {
        return null;
      }

      const path = item.path.trim();
      if (!path) {
        return null;
      }

      return {
        label: typeof item.label === "string" ? item.label.trim() : "",
        path,
      };
    })
    .filter(Boolean);
}

function normalizeDeletedItems(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item.originalPath !== "string" || typeof item.trashPath !== "string") {
        return null;
      }

      const originalPath = item.originalPath.trim();
      const trashPath = item.trashPath.trim();
      if (!originalPath || !trashPath) {
        return null;
      }

      return {
        originalPath,
        trashPath: trashPath.startsWith(`${LEGACY_LOCAL_TRASH_FOLDER}/`)
          ? `${LOCAL_TRASH_FOLDER}/${trashPath.slice(LEGACY_LOCAL_TRASH_FOLDER.length + 1)}`
          : trashPath,
        deletedAt: Number.isFinite(item.deletedAt) ? item.deletedAt : Date.now(),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.deletedAt - left.deletedAt);
}

function parsePinnedItems(value) {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim());
      if (parts.length === 1) {
        return { label: "", path: parts[0] };
      }

      const path = parts.pop();
      const label = parts.join(" | ");
      return { label, path };
    })
    .filter((item) => item.path);
}

function serializePinnedItems(items) {
  return normalizePinnedItems(items)
    .map((item) => (item.label ? `${item.label} | ${item.path}` : item.path))
    .join("\n");
}

function scoreFileNameMatch(name, query) {
  const lowerName = name.toLowerCase();

  if (lowerName === query) {
    return 0;
  }

  if (lowerName.startsWith(query)) {
    return 1;
  }

  const parts = lowerName.split(/[\s_-]+/);
  if (parts.some((part) => part.startsWith(query))) {
    return 2;
  }

  const index = lowerName.indexOf(query);
  return index === -1 ? Number.POSITIVE_INFINITY : 10 + index;
}

function scoreVaultEntryMatch(entry, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return Number.POSITIVE_INFINITY;
  }

  const name = entry.name.toLowerCase();
  const path = entry.path.toLowerCase();
  const tokens = normalizedQuery.split(/[\s/._-]+/).filter(Boolean);
  const typePenalty = entry.type === "folder" ? 2 : 0;

  if (path === normalizedQuery) {
    return typePenalty;
  }

  if (name === normalizedQuery) {
    return 1 + typePenalty;
  }

  if (name.startsWith(normalizedQuery)) {
    return 6 + typePenalty;
  }

  if (path.startsWith(normalizedQuery)) {
    return 10 + typePenalty;
  }

  const folderBoundaryIndex = path.indexOf(`/${normalizedQuery}`);
  if (folderBoundaryIndex !== -1) {
    return 14 + folderBoundaryIndex + typePenalty;
  }

  const nameIndex = name.indexOf(normalizedQuery);
  if (nameIndex !== -1) {
    return 20 + nameIndex + typePenalty;
  }

  const pathIndex = path.indexOf(normalizedQuery);
  if (pathIndex !== -1) {
    return 36 + pathIndex + typePenalty;
  }

  if (!tokens.length) {
    return Number.POSITIVE_INFINITY;
  }

  let totalIndex = 0;
  for (const token of tokens) {
    const tokenIndex = path.indexOf(token);
    if (tokenIndex === -1) {
      return Number.POSITIVE_INFINITY;
    }
    totalIndex += tokenIndex;
  }

  return 60 + totalIndex + typePenalty;
}

function getParentFolderPath(path) {
  if (!path) {
    return null;
  }

  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return "";
  }

  return segments.slice(0, -1).join("/");
}

function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < hour) {
    return `${Math.max(1, Math.round(diff / minute))}m ago`;
  }

  if (diff < day) {
    return `${Math.max(1, Math.round(diff / hour))}h ago`;
  }

  return `${Math.max(1, Math.round(diff / day))}d ago`;
}

function flattenBookmarkEntries(items, results) {
  if (!Array.isArray(items)) {
    return results;
  }

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (item.type === "file" && typeof item.path === "string") {
      results.push(item);
      continue;
    }

    if (Array.isArray(item.items)) {
      flattenBookmarkEntries(item.items, results);
    }
  }

  return results;
}

class LocalStartPageView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.activeTab = plugin.settings.defaultTab;
    this.query = "";
    this.inputEl = null;
    this.searchComponent = null;
    this.statusEl = null;
    this.panelEl = null;
    this.suggestionEl = null;
    this.tabButtons = new Map();
    this.summaryRequestId = 0;
    this.currentSuggestions = [];
    this.selectedSuggestionIndex = 0;
    this.activeFolderPath = null;
    this.treeBodyEl = null;
    // Multi-selection state
    this.selectedItems = new Set();
    this.lastSelectedIndex = -1;
  }

  getViewType() {
    return VIEW_TYPE_START_PAGE;
  }

  getDisplayText() {
    return "Home";
  }

  getIcon() {
    return "house";
  }

  async onOpen() {
    this.render({ focusSearch: true });
  }

  async onClose() {
    this.treeBodyEl = null;
    this.contentEl.empty();
  }

  focusSearch() {
    if (this.searchComponent) {
      this.searchComponent.inputEl.focus();
      this.searchComponent.inputEl.select();
    }
  }

  render(options = {}) {
    const { preserveScroll = false, focusSearch = false } = options;
    const { contentEl } = this;
    const previousScrollTop = preserveScroll ? contentEl.scrollTop : 0;
    contentEl.empty();
    contentEl.addClass("local-start-page");

    const shell = contentEl.createDiv({ cls: "local-start-page__shell" });
    shell.toggleClass("local-start-page__shell--focus-mode", this.plugin.settings.focusMode);

    // Section 1: Greeting (centered, no name)
    const greeting = shell.createDiv({ cls: "local-start-page__greeting" });
    greeting.createEl("h1", {
      cls: "local-start-page__greeting-text",
      text: this.plugin.settings.showGreeting !== false ? this.plugin.getGreetingText() : "Welcome",
    });
    greeting.createEl("p", {
      cls: "local-start-page__greeting-sub",
      text: this.plugin.settings.subtitle || "Search files and folders across your vault",
    });

    // Section 2: Search bar (directly under the greeting)
    if (this.plugin.settings.showSearch !== false) {
      const searchRow = shell.createDiv({ cls: "local-start-page__search" });
      const searchWrap = searchRow.createDiv({ cls: "local-start-page__search-wrap" });
      this.searchComponent = new SearchComponent(searchWrap);
      this.searchComponent.setPlaceholder("Search files and folders");
      this.searchComponent.setValue(this.query);
      this.inputEl = this.searchComponent.inputEl;
      this.suggestionEl = shell.createDiv({ cls: "local-start-page__suggestions" });
      this.suggestionEl.hide();
      if (focusSearch) { setTimeout(() => this.focusSearch(), 0); }
      this.searchComponent.onChange((value) => {
        this.query = value;
        this.selectedSuggestionIndex = 0;
        this.renderSuggestions();
        this.renderPanel();
      });
      this.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const sel = this.selectedItems && this.selectedItems.values ? this.selectedItems.values().next().value : null;
          if (sel && sel.path) { this.openFileNew(sel.path); this.resetSearch(); }
        } else if (e.key === "Escape") {
          if (this.query) { this.resetSearch(); } else { this.inputEl.blur(); }
        }
      });
    } else {
      this.inputEl = null;
      this.searchComponent = null;
      this.suggestionEl = null;
    }

    // Quick actions (Open last note / New note)
    if (this.plugin.settings.showQuickCapture !== false) {
      this.renderQuickActions(shell);
    }

    // Section 3: Recent (horizontal cards)
    if (this.plugin.settings.showRecent !== false) {
      const recent = this.plugin.getRecentItems(this.plugin.settings.showTempNotes !== false).slice(0, this.plugin.settings.maxRecent);
      if (recent.length) {
        const section = shell.createDiv({ cls: "local-start-page__section" });
        this.renderSectionHeader(section, "Recent", "clock");
        const grid = section.createDiv({ cls: "local-start-page__card-row" });
        for (const item of recent) {
          const card = grid.createDiv({ cls: "local-start-page__page-card" });
          card.tabIndex = 0;
          card.setAttr("role", "button");
          const open = () => { if (item.path) this.openFileNew(item.path); };
          card.addEventListener("click", open);
          card.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
          });
          const iconWrap = card.createDiv({ cls: "local-start-page__page-card-icon" });
          setIcon(iconWrap, item.badge ? "file-text" : "file");
          card.createEl("div", { cls: "local-start-page__page-card-title", text: item.title });
          card.createEl("div", {
            cls: "local-start-page__page-card-meta",
            text: item.meta || "",
          });
          card.addEventListener("contextmenu", (e) => {
            this.showContextMenu(e, [
              {
                title: "Hide from recent",
                icon: "eye-off",
                onClick: () => this.removeFromRecentHistory(item.path),
              },
              {
                title: "Move to bin",
                icon: "trash",
                danger: true,
                onClick: () => this.moveToBin(item.path),
              },
            ]);
          });
        }
      }
    }

    // Section 4b: Tasks (self-contained, with add / complete / delete / reorder)
    if (this.plugin.settings.showTasks !== false) {
      const section = shell.createDiv({ cls: "local-start-page__section" });
      this.renderSectionHeader(section, "Tasks", "check-square");

      // "+" button on the right of the header
      const headerEl = section.querySelector(".local-start-page__section-title");
      if (headerEl) {
        const addBtn = headerEl.createEl("button", { cls: "local-start-page__section-action" });
        addBtn.type = "button";
        addBtn.setAttr("aria-label", "Add task");
        setIcon(addBtn, "plus");
        addBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.promptAddTask();
        });
      }

      const tasks = this.plugin.settings.tasks || [];
      if (tasks.length) {
        const list = section.createDiv({ cls: "local-start-page__task-list" });
        for (const task of tasks) {
          const row = list.createDiv({ cls: "local-start-page__task-row" });
          row.setAttr("data-task-id", task.id);
          row.draggable = true;
          if (task.done) row.addClass("is-done");

          const box = row.createEl("button", { cls: "local-start-page__task-check" });
          box.type = "button";
          box.setAttr("aria-label", task.done ? "Mark incomplete" : "Mark complete");
          setIcon(box, task.done ? "check" : "square");
          box.addEventListener("click", (e) => {
            e.stopPropagation();
            this.plugin.toggleLocalTask(task.id).then(() => this.refreshViews());
          });

          const label = row.createDiv({ cls: "local-start-page__task-label" });
          label.textContent = task.text;
          label.addEventListener("click", () => {
            if (task.done) return;
            this.plugin.toggleLocalTask(task.id).then(() => this.refreshViews());
          });

          // three dot menu (delete)
          const dots = row.createEl("button", { cls: "local-start-page__task-menu" });
          dots.type = "button";
          dots.setAttr("aria-label", "Task options");
          setIcon(dots, "more-vertical");
          dots.addEventListener("click", (e) => {
            e.stopPropagation();
            this.showContextMenu(e, [
              {
                title: "Delete task",
                icon: "trash",
                danger: true,
                onClick: () => { this.plugin.removeTask(task.id).then(() => this.refreshViews()); },
              },
            ]);
          });

          // drag and drop reorder
          row.addEventListener("dragstart", (e) => {
            row.addClass("is-dragging");
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", task.id);
          });
          row.addEventListener("dragend", () => row.removeClass("is-dragging"));
          row.addEventListener("dragover", (e) => {
            e.preventDefault();
            row.addClass("is-drop-target");
          });
          row.addEventListener("dragleave", () => row.removeClass("is-drop-target"));
          row.addEventListener("drop", (e) => {
            e.preventDefault();
            row.removeClass("is-drop-target");
            const draggedId = e.dataTransfer.getData("text/plain");
            if (!draggedId || draggedId === task.id) return;
            const ids = (this.plugin.settings.tasks || []).map((t) => t.id);
            const from = ids.indexOf(draggedId);
            const to = ids.indexOf(task.id);
            if (from === -1 || to === -1) return;
            const moved = ids.splice(from, 1)[0];
            ids.splice(to, 0, moved);
            this.plugin.reorderTasks(ids).then(() => this.refreshViews());
          });
        }
      } else {
        section.createEl("p", { cls: "local-start-page__section-empty", text: "No tasks yet. Use the + button to add one." });
      }
    }

    // Section 5: Bookmarks (added back from original)
    if (this.plugin.settings.showBookmarks !== false) {
      this.renderBookmarksPanel(shell);
    }

    // Section 6: Favorites tray (added back from original)
    if (this.plugin.settings.showFavorites !== false) {
      this.renderFavoritesTray(shell);
    }

    // Full homepage layout always: vault tree then Bin at the bottom.
    if (this.plugin.settings.showVaultTree !== false) {
      const treeSection = shell.createDiv({ cls: "local-start-page__section local-start-page__vault-tree-section" });
      this.renderSectionHeader(treeSection, "Vault tree", "folder-tree");
      this.treeBodyEl = treeSection.createDiv({ cls: "local-start-page__vault-tree-body" });
      this.renderFileTree(this.treeBodyEl);
    }

    // Bin: the very last section at the bottom of the homepage
    if (this.plugin.settings.showDeleted !== false) {
      this.renderBin(shell);
    }

    // Tag this view's workspace tab header so CSS can shorten ONLY the Home tab
    // (left to right) without affecting any other tabs or windows.
    this.tagHomeTab();

    if (preserveScroll) { contentEl.scrollTop = previousScrollTop; }
  }

  // Add a marker class to the workspace tab header that belongs to this Home view.
  tagHomeTab() {
    try {
      const all = document.querySelectorAll(".workspace-tab-header");
      for (const tabHeader of all) {
        if ((tabHeader.textContent || "").includes("Home")) {
          tabHeader.addClass("local-start-page__home-tab");
        }
      }
    } catch (e) { /* non-critical */ }
  }

  renderSectionHeader(container, label, icon) {
    const header = container.createDiv({ cls: "local-start-page__section-title" });
    if (icon) {
      const iconWrap = header.createSpan({ cls: "local-start-page__section-icon" });
      setIcon(iconWrap, icon);
    }
    header.createSpan({ text: label });
  }

  // Forward to the plugin's re-render so all in-homepage actions refresh the view.
  refreshViews(options) {
    this.plugin.refreshViews(options);
  }

  promptAddTask() {
    const section = this.contentEl.querySelector(".local-start-page__section");
    // find the Tasks section specifically
    const sections = Array.from(this.contentEl.querySelectorAll(".local-start-page__section"));
    const tasksSection = sections.find((s) => /Tasks?/.test(s.querySelector(".local-start-page__section-title")?.textContent || ""));
    if (!tasksSection) return;
    // avoid duplicate input
    if (tasksSection.querySelector(".local-start-page__task-input-row")) {
      tasksSection.querySelector(".local-start-page__task-input-row input")?.focus();
      return;
    }
    const inputRow = tasksSection.createDiv({ cls: "local-start-page__task-input-row" });
    const input = inputRow.createEl("input", { cls: "local-start-page__task-input", type: "text", placeholder: "New task…" });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const val = input.value.trim();
        if (val) {
          this.plugin.addTask(val).then(() => this.refreshViews());
        }
      } else if (e.key === "Escape") {
        inputRow.remove();
      }
    });
    input.addEventListener("blur", () => {
      if (!input.value.trim()) inputRow.remove();
    });
    input.focus();
  }

  renderQuickActions(container) {
    const row = container.createDiv({ cls: "local-start-page__quick-actions" });

    // Open last note -> dropdown of the last closed notes
    const reopenWrap = row.createDiv({ cls: "local-start-page__dropdown" });
    const reopen = reopenWrap.createEl("button", { cls: "local-start-page__quick-action-button local-start-page__dropdown-trigger" });
    reopen.type = "button";
    setIcon(reopen.createSpan({ cls: "local-start-page__quick-action-icon" }), "history");
    reopen.createSpan({ text: "Open last note" });
    const reopenMenu = reopenWrap.createDiv({ cls: "local-start-page__dropdown-list" });
    const recentClosed = (this.plugin.settings.recentHistory || []).slice(0, 5);
    if (recentClosed.length) {
      for (const path of recentClosed) {
        const file = this.app.vault.getAbstractFileByPath(path);
        const title = file instanceof TFile ? file.basename : path.split("/").pop().replace(/\.md$/, "");
        const option = reopenMenu.createEl("button", { cls: "local-start-page__dropdown-item", text: title });
        option.type = "button";
        option.addEventListener("click", async () => {
          reopenMenu.toggleClass("is-visible", false);
          const target = this.app.vault.getAbstractFileByPath(path);
          if (target instanceof TFile) { this.openFileNew(path); }
        });
      }
    } else {
      reopenMenu.createEl("button", { cls: "local-start-page__dropdown-item", text: "No recently closed notes", disabled: true });
    }
    reopen.addEventListener("click", (e) => {
      e.stopPropagation();
      reopenMenu.toggleClass("is-visible", !reopenMenu.hasClass("is-visible"));
    });
    // close the menu when clicking anywhere outside it
    document.addEventListener("click", (ev) => {
      if (reopenMenu.hasClass("is-visible") && !reopenWrap.contains(ev.target)) {
        reopenMenu.toggleClass("is-visible", false);
      }
    });

    // New temporary note -> creates into the temporary folder
    const newNote = row.createEl("button", { cls: "local-start-page__quick-action-button" });
    newNote.type = "button";
    setIcon(newNote.createSpan({ cls: "local-start-page__quick-action-icon" }), "file-plus");
    newNote.createSpan({ text: "New temporary note" });
    newNote.addEventListener("click", async () => {
      await this.plugin.createTemporaryNote(this.app.workspace.getLeaf(true), this.plugin.settings.tempFolder);
    });
  }

  showContextMenu(event, items) {
    event.preventDefault();
    event.stopPropagation();
    const { Menu } = require("obsidian");
    const menu = new Menu();
    for (const item of items) {
      menu.addItem((mi) => {
        mi.setTitle(item.title);
        if (item.icon) mi.setIcon(item.icon);
        if (item.danger) mi.setWarning(true);
        mi.onClick(() => item.onClick());
      });
    }
    menu.showAtPosition({ x: event.clientX, y: event.clientY });
  }

  // Open a file in a brand-new TAB so the Home view itself is never replaced or
  // resized. Falls back to a new split leaf if "tab" isn't supported.
  openFileNew(path) {
    let leaf;
    try {
      leaf = this.app.workspace.getLeaf("tab");
    } catch (e) {
      leaf = this.app.workspace.getLeaf(true);
    }
    this.plugin.openFile(path, leaf);
  }

  // Move a note into the Bin (local trash) from any section's right-click menu.
  moveToBin(path) {
    if (typeof path !== "string" || !path.trim()) return;
    this.plugin.trashNote(path).then(() => this.refreshViews());
  }

  async removeFromRecentHistory(path) {
    if (typeof path !== "string" || !path.trim()) return;
    const normalizedPath = path.trim();
    this.settings.recentHistory = this.settings.recentHistory.filter((p) => p !== normalizedPath);
    await this.saveData(this.settings);
    this.refreshViews();
  }

  renderFileTree(container) {
    container.empty();

    const root = typeof this.app.vault.getRoot === "function" ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath("");
    if (!(root instanceof TFolder)) {
      container.createEl("p", {
        cls: "local-start-page__empty",
        text: "Could not read the vault tree.",
      });
      return;
    }

    const noteCounts = this.plugin.getFolderNoteCounts();
    const rootBranch = container.createDiv({ cls: "local-start-page__tree-root" });
    this.renderFolderChildren(rootBranch, root, noteCounts, 0);
  }

  renderFolderChildren(container, folder, noteCounts, depth) {
    const childFolders = folder.children
      .filter(
        (child) =>
          child instanceof TFolder &&
          this.plugin.isSearchablePath(child.path) &&
          (noteCounts.get(child.path) || 0) > 0
      )
      .sort((left, right) => left.name.localeCompare(right.name));

    const childFiles = folder.children
      .filter((child) => child instanceof TFile && this.plugin.isSearchablePath(child.path))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const childFolder of childFolders) {
      this.renderFolderTreeNode(container, childFolder, noteCounts, depth);
    }

    if (depth > 0) {
      for (const childFile of childFiles) {
        this.renderTreeFileNode(container, childFile, depth);
      }
    }
  }

  renderFolderTreeNode(container, folder, noteCounts, depth) {
    const details = container.createEl("details", { cls: "local-start-page__tree-folder" });
    details.style.setProperty("--tree-depth", String(depth));
    details.open = this.shouldAutoOpenTreeFolder(folder.path, depth);
    details.setAttr("data-folder-path", folder.path);
    // Drop target for drag and drop
    details.setAttr("data-drop-target", "true");

    const summary = details.createEl("summary", { cls: "local-start-page__tree-summary" });
    summary.setAttr("data-folder-path", folder.path);
    const summaryMain = summary.createDiv({ cls: "local-start-page__tree-summary-main" });

    const caret = summaryMain.createSpan({ cls: "local-start-page__tree-caret" });
    setIcon(caret, "chevron-right");

    const iconWrap = summaryMain.createSpan({ cls: "local-start-page__tree-node-icon" });
    setIcon(iconWrap, "folder");

    summaryMain.createSpan({
      cls: "local-start-page__tree-node-label",
      text: folder.name,
    });

    summary.createSpan({
      cls: "local-start-page__tree-node-badge",
      text: `${noteCounts.get(folder.path) || 0}`,
    });

    // Drag-and-drop event handlers for folder drop target
    summary.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      summary.addClass("is-drag-over");
    });
    summary.addEventListener("dragleave", (e) => {
      // Only remove if leaving the summary entirely
      if (!summary.contains(e.relatedTarget)) {
        summary.removeClass("is-drag-over");
      }
    });
    summary.addEventListener("drop", (e) => {
      e.preventDefault();
      summary.removeClass("is-drag-over");
      const data = e.dataTransfer.getData("application/json");
      if (data) {
        try {
          const paths = JSON.parse(data);
          this.handleDropToFolder(paths, folder.path);
        } catch (err) {
          console.error("Failed to parse drop data:", err);
        }
      }
    });

    const childrenWrap = details.createDiv({ cls: "local-start-page__tree-children" });
    const childrenInner = childrenWrap.createDiv({ cls: "local-start-page__tree-children-inner" });
    this.renderFolderChildren(childrenInner, folder, noteCounts, depth + 1);
  }

  renderTreeFileNode(container, file, depth) {
    const button = container.createEl("button", {
      cls: "local-start-page__tree-file",
    });
    button.type = "button";
    button.style.setProperty("--tree-depth", String(depth));
    button.draggable = true;
    button.setAttr("data-file-path", file.path);

    const isSelected = this.selectedItems.has(file.path);
    if (isSelected) {
      button.addClass("is-selected");
    }

    const iconWrap = button.createSpan({ cls: "local-start-page__tree-node-icon" });
    setIcon(iconWrap, "file-text");
    button.createSpan({
      cls: "local-start-page__tree-node-label",
      text: file.extension === "md" ? file.basename : file.name,
    });

    // Click handler with selection support
    button.addEventListener("click", (event) => {
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const ctrlOrMeta = isMac ? event.metaKey : event.ctrlKey;
      const shiftKey = event.shiftKey;

      // Cmd/Ctrl+Click: Open in new tab
      if (ctrlOrMeta) {
        event.preventDefault();
        let leaf;
        try { leaf = this.app.workspace.getLeaf("tab"); } catch (e) { leaf = this.app.workspace.getLeaf(true); }
        this.plugin.openFile(file.path, leaf);
        return;
      }

      // Handle selection with keyboard modifiers
      this.toggleItemSelection(file.path, -1, event);

      // If not selecting (no shift modifier), also trigger the original action
      if (!shiftKey) {
        this.openFileNew(file.path);
      }
    });

    // Keyboard support for tree files
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
        const ctrlOrMeta = isMac ? event.metaKey : event.ctrlKey;
        const shiftKey = event.shiftKey;
        if (shiftKey || ctrlOrMeta) {
          this.toggleItemSelection(file.path, -1, event);
        } else {
          this.plugin.openFile(file.path, leaf);
        }
      }
      // Escape to clear selection
      if (event.key === "Escape" && this.selectedItems.size > 0) {
        this.clearSelection();
      }
    });

    // Drag-and-drop event handlers for draggable files
    button.addEventListener("dragstart", (e) => {
      const paths = this.selectedItems.size > 0 && this.selectedItems.has(file.path)
        ? Array.from(this.selectedItems)
        : [file.path];
      e.dataTransfer.setData("application/json", JSON.stringify(paths));

      e.dataTransfer.effectAllowed = "move";
      button.addClass("is-dragging");
    });
    button.addEventListener("dragend", () => {
      button.removeClass("is-dragging");
    });

    // Right-click: add to favorites (pin) or bookmark globally
    button.addEventListener("contextmenu", (e) => {
      const alreadyPinned = this.plugin.isPinnedPath(file.path);
      this.showContextMenu(e, [
        {
          title: alreadyPinned ? "Remove from favorites" : "Add to favorites",
          icon: alreadyPinned ? "star-off" : "star",
          onClick: () => { this.plugin.togglePinnedItem(file.path); this.refreshViews(); },
        },
        {
          title: "Bookmark",
          icon: "bookmark",
          onClick: async () => { await this.plugin.addGlobalBookmark(file.path); this.refreshViews(); },
        },
        {
          title: "Move to bin",
          icon: "trash",
          danger: true,
          onClick: () => this.moveToBin(file.path),
        },
      ]);
    });
  }

  async handleDropToFolder(paths, targetFolderPath) {
    let moved = 0;
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const newPath = targetFolderPath
          ? `${targetFolderPath}/${file.name}`
          : file.name;
        try {
          await this.app.fileManager.renameFile(file, newPath);
          moved++;
        } catch (error) {
          console.error("Failed to move file:", path, error);
        }
      }
    }
    if (moved > 0) {
      this.clearSelection();
      new Notice(`Moved ${moved} note${moved === 1 ? "" : "s"}`);
    }
  }

  shouldAutoOpenTreeFolder(path, depth) {
    return Boolean(this.activeFolderPath && (this.activeFolderPath === path || this.activeFolderPath.startsWith(`${path}/`)));
  }

  focusTreeFolder(path) {
    this.activeFolderPath = path;
    if (this.treeBodyEl) {
      this.renderFileTree(this.treeBodyEl);
    }

    window.setTimeout(() => {
      if (!this.treeBodyEl) {
        return;
      }

      const escapedPath = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(path) : path.replace(/"/g, '\\"');
      const target = this.treeBodyEl.querySelector(`[data-folder-path="${escapedPath}"]`);
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }, 0);
  }

  resetSearch() {
    this.query = "";
    this.currentSuggestions = [];
    this.selectedSuggestionIndex = 0;

    if (this.searchComponent) {
      this.searchComponent.setValue("");
    }

    this.renderSuggestions();
  }

  activateSearchEntry(entry) {
    if (!entry) {
      return;
    }

    if (entry.type === "folder") {
      this.focusTreeFolder(entry.path);
      return;
    }

    this.plugin.openFile(entry.path, this.leaf);
  }

  openFolder(path) {
    this.resetSearch();
    this.focusTreeFolder(path);
  }

  renderSuggestions() {
    if (!this.suggestionEl) {
      return;
    }

    this.suggestionEl.empty();

    const query = this.query.trim();
    if (!query) {
      this.currentSuggestions = [];
      this.suggestionEl.hide();
      return;
    }

    this.currentSuggestions = this.plugin.searchVaultEntries(query, this.plugin.settings.maxSearchResults);
    if (!this.currentSuggestions.length) {
      this.suggestionEl.hide();
      return;
    }

    this.suggestionEl.show();

    this.currentSuggestions.forEach((entry, index) => {
      const item = this.suggestionEl.createDiv({ cls: "local-start-page__suggestion" });
      if (index === this.selectedSuggestionIndex) {
        item.addClass("is-selected");
      }

      item.createEl("span", {
        cls: `local-start-page__suggestion-kind local-start-page__suggestion-kind--${entry.type}`,
        text: entry.type === "folder" ? "Folder" : entry.kindLabel,
      });

      item.createEl("div", {
        cls: "local-start-page__suggestion-title",
        text: entry.name,
      });
      item.createEl("div", {
        cls: "local-start-page__suggestion-path",
        text: entry.path || this.plugin.getVaultRootLabel(),
      });

      item.addEventListener("mouseenter", () => {
        this.selectedSuggestionIndex = index;
        this.renderSuggestions();
      });
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.activateSearchEntry(entry);
      });
    });
  }

  async renderSummaries(container) {
    const requestId = ++this.summaryRequestId;
    container.empty();

    const filesCard = container.createDiv({ cls: "local-start-page__summary-card" });
    filesCard.createEl("p", {
      cls: "local-start-page__summary-label",
      text: "Files",
    });
    filesCard.createEl("div", {
      cls: "local-start-page__summary-value",
      text: String(this.plugin.getAllFiles().length),
    });
    filesCard.createEl("p", {
      cls: "local-start-page__summary-meta",
      text: "Markdown notes in this vault",
    });

    const activityCard = container.createDiv({ cls: "local-start-page__summary-card" });
    activityCard.createEl("p", {
      cls: "local-start-page__summary-label",
      text: "Added Today",
    });
    activityCard.createEl("div", {
      cls: "local-start-page__summary-value",
      text: String(this.plugin.getNotesAddedInLastDay()),
    });
    activityCard.createEl("p", {
      cls: "local-start-page__summary-meta",
      text: "Notes created in the last 24 hours",
    });

    const bookmarksCard = container.createDiv({ cls: "local-start-page__summary-card" });
    bookmarksCard.createEl("p", {
      cls: "local-start-page__summary-label",
      text: "Bookmarks",
    });
    const bookmarkHeader = bookmarksCard.createDiv({ cls: "local-start-page__bookmark-header" });
    const bookmarkCount = bookmarkHeader.createEl("div", {
      cls: "local-start-page__summary-value local-start-page__summary-value--small",
      text: "...",
    });
    const bookmarkList = bookmarksCard.createDiv({ cls: "local-start-page__bookmark-list" });

    const bookmarks = await this.plugin.getBookmarkItems();
    if (requestId !== this.summaryRequestId) {
      return;
    }

    bookmarkCount.setText(String(bookmarks.length));
    bookmarksCard.createEl("p", {
      cls: "local-start-page__summary-meta local-start-page__summary-meta--inline",
      text: bookmarks.length === 1 ? "Saved bookmark" : "Saved bookmarks",
    });

    if (!bookmarks.length) {
      bookmarkList.createEl("p", {
        cls: "local-start-page__summary-empty",
        text: "No bookmarked notes",
      });
      return;
    }

    for (const bookmark of bookmarks.slice(0, 4)) {
      const button = bookmarkList.createEl("button", {
        cls: "local-start-page__bookmark-chip",
        text: bookmark.title,
      });
      button.type = "button";
      button.title = bookmark.path;
      button.addEventListener("click", () => this.openFileNew(bookmark.path));
    }
  }

  renderBookmarksPanel(container) {
    const section = container.createDiv({ cls: "local-start-page__section" });
    this.renderSectionHeader(section, "Bookmarks", "bookmark");
    const list = section.createDiv({ cls: "local-start-page__event-list" });

    this.plugin.getBookmarkItems().then((bookmarks) => {
      if (!bookmarks.length) {
        section.createEl("p", { cls: "local-start-page__section-empty", text: "No bookmarked notes yet." });
        return;
      }

      for (const bookmark of bookmarks.slice(0, 12)) {
        const row = list.createDiv({ cls: "local-start-page__event-row" });
        row.createEl("span", { cls: "local-start-page__event-dot" });
        const text = row.createDiv({ cls: "local-start-page__event-text" });
        text.createEl("span", { cls: "local-start-page__event-title", text: bookmark.title });
        text.createEl("span", { cls: "local-start-page__event-path", text: bookmark.path });
        row.tabIndex = 0;
        row.setAttr("role", "button");
        const open = () => this.openFileNew(bookmark.path);
        row.addEventListener("click", open);
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
        });
        row.addEventListener("contextmenu", (e) => {
          this.showContextMenu(e, [
            {
              title: "Remove from bookmarks",
              icon: "bookmark-minus",
              onClick: () => { this.plugin.removeBookmarkHint(bookmark.path); this.refreshViews(); },
            },
            {
              title: "Move to bin",
              icon: "trash",
              danger: true,
              onClick: () => this.moveToBin(bookmark.path),
            },
          ]);
        });
      }
    });
  }

  renderFavoritesTray(container) {
    const section = container.createDiv({ cls: "local-start-page__section" });
    this.renderSectionHeader(section, "Favorites", "star");
    const list = section.createDiv({ cls: "local-start-page__event-list" });

    const pinnedItems = this.plugin.getPinnedItems();
    if (!pinnedItems.length) {
      section.createEl("p", { cls: "local-start-page__section-empty", text: "No favorites yet. Add pinned notes in settings." });
      return;
    }

    for (const item of pinnedItems.slice(0, 12)) {
      const row = list.createDiv({ cls: "local-start-page__event-row" });
      row.createEl("span", { cls: "local-start-page__event-dot" });
      const text = row.createDiv({ cls: "local-start-page__event-text" });
      text.createEl("span", { cls: "local-start-page__event-title", text: item.label || (item.missing ? `${item.path} (missing)` : item.path.split("/").pop().replace(/\.md$/, "")) });
      text.createEl("span", { cls: "local-start-page__event-path", text: item.path });
      if (item.missing) {
        row.setAttr("aria-disabled", "true");
        row.addClass("is-missing");
      } else {
        row.tabIndex = 0;
        row.setAttr("role", "button");
        row.addEventListener("click", () => this.openFileNew(item.path));
        row.addEventListener("contextmenu", (e) => {
          this.showContextMenu(e, [
            {
              title: "Remove from favorites",
              icon: "star-off",
              onClick: () => { this.plugin.togglePinnedItem(item.path); this.refreshViews(); },
            },
            {
              title: "Move to bin",
              icon: "trash",
              danger: true,
              onClick: () => this.moveToBin(item.path),
            },
          ]);
        });
      }
    }
  }

  renderBin(shell) {
    const section = shell.createDiv({ cls: "local-start-page__section" });
    this.renderSectionHeader(section, "Bin", "trash");

    // Clear-bin button on the right of the header
    const headerEl = section.querySelector(".local-start-page__section-title");
    if (headerEl) {
      const clearBtn = headerEl.createEl("button", { cls: "local-start-page__section-action" });
      clearBtn.type = "button";
      clearBtn.setAttr("aria-label", "Clear bin");
      setIcon(clearBtn, "trash-2");
      clearBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.plugin.clearBin();
        this.refreshViews();
      });
    }

    const deletedItems = this.plugin.getDeletedItems().map((item) => ({
      ...item,
      // Clicking a bin item opens it in a brand-new leaf so Home stays intact.
      onClick: item.missing ? undefined : () => this.openFileNew(item.path),
    }));

    const body = section.createDiv({ cls: "local-start-page__bin-body" });
    this.renderList(
      deletedItems,
      "Bin is empty.\n\nNotes rest here as temporary pins until you restore or remove them permanently.",
      body
    );
  }

  renderPanel() {
    console.log("Local Start Page: renderPanel start", this.activeTab);
    if (!this.panelEl || !this.statusEl) {
      console.log("Local Start Page: renderPanel skipped - missing panelEl/statusEl");
      return;
    }

    this.panelEl.empty();

    // Bulk actions toolbar (shown when items are selected)
    if (this.selectedItems.size > 0) {
      this.renderBulkActionsToolbar();
    }

    for (const [tabId, button] of this.tabButtons.entries()) {
      button.toggleClass("is-active", !this.query && this.activeTab === tabId);
    }

    const query = this.query.trim().toLowerCase();
    if (query) {
      const results = this.plugin.searchVaultEntries(query);
      this.statusEl.setText(
        results.length === 0
          ? "No matching files or folders"
          : `${results.length} matching ${results.length === 1 ? "result" : "results"}`
      );
      this.renderList(
        results.map((entry) => ({
          title: entry.name,
          path: entry.path,
          meta: entry.path || this.plugin.getVaultRootLabel(),
          badge: entry.type === "folder" ? `${entry.childFolderCount} subfolder${entry.childFolderCount === 1 ? "" : "s"}` : entry.kindLabel,
          onClick: () => this.activateSearchEntry(entry),
          actions: entry.type === "file" ? this.createNoteActions(entry.path) : [],
        })),
        "Start typing to search the vault."
      );
      return;
    }

    if (this.activeTab === "deleted") {
      const deletedItems = this.plugin.getDeletedItems();
      this.statusEl.setText(
        deletedItems.length === 0 ? "Bin is empty" : `${deletedItems.length} note${deletedItems.length === 1 ? "" : "s"} in the bin`
      );
      // Clear-bin button (right side)
      const clearBtn = this.panelEl.createDiv({ cls: "local-start-page__clear-bin" });
      const clearButton = clearBtn.createEl("button", { cls: "local-start-page__clear-bin-button", text: "Clear bin" });
      clearButton.type = "button";
      clearButton.addEventListener("click", async () => {
        await this.plugin.clearBin();
        this.renderPanel();
      });
      this.renderList(deletedItems, "Bin is empty.\n\nNotes rest here as temporary pins until you restore or remove them permanently.");
      return;
    }

    if (this.activeTab === "pinned") {
      const pinnedItems = this.plugin.getPinnedItems();
      this.statusEl.setText(
        pinnedItems.length === 0 ? "No pinned notes configured" : `${pinnedItems.length} pinned note${pinnedItems.length === 1 ? "" : "s"}`
      );
      this.renderList(
        pinnedItems.map((item) => ({
          ...item,
          actions: item.path && !item.missing ? this.createNoteActions(item.path) : [],
        })),
        "Add pinned notes in Local Home Page settings."
      );
      return;
    }

    if (this.activeTab === "tasks") {
      const taskItems = this.plugin.getTaskItems(this.plugin.settings.maxTasks, this.plugin.settings.tasksFilterQuery);
      this.statusEl.setText(
        taskItems.length === 0 ? "No tasks found" : `${taskItems.length} task${taskItems.length === 1 ? "" : "s"}`
      );
      this.renderList(
        taskItems,
        "Tasks will appear here when the Tasks plugin is installed and has incomplete tasks."
      );
      return;
    }

    const recentItems = this.plugin.getRecentItems(this.plugin.settings.showTempNotes !== false);
    this.statusEl.setText(
      recentItems.length === 0 ? "No recent notes yet" : `${recentItems.length} recent note${recentItems.length === 1 ? "" : "s"}`
    );
    this.renderList(
      recentItems.map((item) => ({
        ...item,
        actions: this.createNoteActions(item.path),
      })),
      "Open notes and they will appear here."
    );
  }

  renderBulkActionsToolbar() {
    const toolbar = this.panelEl.createDiv({ cls: "local-start-page__bulk-toolbar" });
    const count = toolbar.createEl("span", {
      cls: "local-start-page__bulk-count",
      text: `${this.selectedItems.size} item${this.selectedItems.size === 1 ? "" : "s"} selected`,
    });

    const actions = toolbar.createDiv({ cls: "local-start-page__bulk-actions" });

    // Move to folder
    const moveBtn = actions.createEl("button", {
      cls: "local-start-page__bulk-button",
      text: "Move to folder…",
    });
    moveBtn.type = "button";
    moveBtn.addEventListener("click", () => this.bulkMoveToFolder());

    // Pin/Unpin
    const pinBtn = actions.createEl("button", {
      cls: "local-start-page__bulk-button",
      text: "Pin/Unpin",
    });
    pinBtn.type = "button";
    pinBtn.addEventListener("click", () => this.bulkTogglePin());

    // Delete (move to trash)
    const deleteBtn = actions.createEl("button", {
      cls: "local-start-page__bulk-button is-danger",
      text: "Move to trash",
    });
    deleteBtn.type = "button";
    deleteBtn.addEventListener("click", () => this.bulkTrash());

    // Copy paths
    const copyBtn = actions.createEl("button", {
      cls: "local-start-page__bulk-button",
      text: "Copy paths",
    });
    copyBtn.type = "button";
    copyBtn.addEventListener("click", () => this.bulkCopyPaths());

    // Clear selection
    const clearBtn = actions.createEl("button", {
      cls: "local-start-page__bulk-button is-ghost",
      text: "Clear selection",
    });
    clearBtn.type = "button";
    clearBtn.addEventListener("click", () => this.clearSelection());
  }

  async bulkMoveToFolder() {
    // Get all available folders
    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((entry) => entry instanceof TFolder)
      .filter((folder) => !folder.path || this.plugin.isSearchablePath(folder.path))
      .map((folder) => ({
        title: folder.path === "" ? "Vault root" : folder.name,
        path: folder.path,
      }));

    if (!folders.length) {
      new Notice("No folders available");
      return;
    }

    // Create a modal for folder selection
    const modal = new (require("obsidian").Modal)(this.app);
    modal.titleEl.setText("Move to folder");
    const container = modal.contentEl;
    container.addClass("local-start-page__folder-modal");

    const searchInput = container.createEl("input", {
      type: "text",
      placeholder: "Search folders…",
      cls: "local-start-page__folder-search",
    });

    const folderList = container.createDiv({ cls: "local-start-page__folder-list" });

    const renderFolderList = (filter = "") => {
      folderList.empty();
      const filtered = folders.filter((f) =>
        f.title.toLowerCase().includes(filter.toLowerCase())
      );
      for (const folder of filtered) {
        const btn = folderList.createEl("button", {
          cls: "local-start-page__folder-option",
          text: folder.title || folder.path,
        });
        btn.type = "button";
        btn.addEventListener("click", async () => {
          await this.executeBulkMove(folder.path);
          modal.close();
        });
      }
    };

    renderFolderList();
    searchInput.addEventListener("input", (e) => renderFolderList(e.target.value));
    searchInput.focus();

    modal.open();
  }

  async executeBulkMove(targetFolderPath) {
    const paths = Array.from(this.selectedItems);
    let moved = 0;
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const newPath = targetFolderPath
          ? `${targetFolderPath}/${file.name}`
          : file.name;
        try {
          await this.app.fileManager.renameFile(file, newPath);
          moved++;
        } catch (error) {
          console.error("Failed to move file:", path, error);
        }
      }
    }
    this.clearSelection();
    new Notice(`Moved ${moved} note${moved === 1 ? "" : "s"}`);
  }

  async bulkTogglePin() {
    const paths = Array.from(this.selectedItems);
    let toggled = 0;
    for (const path of paths) {
      await this.plugin.togglePinnedItem(path);
      toggled++;
    }
    this.clearSelection();
    new Notice(`${toggled} note${toggled === 1 ? "" : "s"} pinned/unpinned`);
  }

  async bulkTrash() {
    const paths = Array.from(this.selectedItems);
    let trashed = 0;
    for (const path of paths) {
      await this.plugin.trashNote(path);
      trashed++;
    }
    this.clearSelection();
    new Notice(`Moved ${trashed} note${trashed === 1 ? "" : "s"} to trash`);
  }

  bulkCopyPaths() {
    const paths = Array.from(this.selectedItems);
    navigator.clipboard.writeText(paths.join("\n"));
    this.clearSelection();
    new Notice(`Copied ${paths.length} path${paths.length === 1 ? "" : "s"}`);
  }

  openSelectedInNewWindows() {
    const paths = Array.from(this.selectedItems);
    for (const path of paths) {
      const leaf = this.app.workspace.getLeaf(true);
      this.openFile(path, leaf);
    }
    this.clearSelection();
    new Notice(`Opened ${paths.length} note${paths.length === 1 ? "" : "s"} in new windows`);
  }

  clearSelection() {
    this.selectedItems.clear();
    this.lastSelectedIndex = -1;
    this.renderPanel();
  }

  toggleItemSelection(path, index, event) {
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const ctrlOrMeta = isMac ? event.metaKey : event.ctrlKey;
    const shiftKey = event.shiftKey;

    if (shiftKey) {
      // Shift+Click: Toggle selection (add/remove from selection)
      if (this.selectedItems.has(path)) {
        this.selectedItems.delete(path);
      } else {
        this.selectedItems.add(path);
        this.lastSelectedIndex = index;
      }
    } else if (ctrlOrMeta) {
      // Cmd/Ctrl+Click: Don't change selection, handled by click handler for opening in new window
      return;
    } else {
      // Single click (no modifier): Clear selection, select this item
      this.selectedItems.clear();
      this.selectedItems.add(path);
      this.lastSelectedIndex = index;
    }
    this.renderPanel();
  }

  createNoteActions(path) {
    if (!path) {
      return [];
    }

    return [
      {
        icon: "trash",
        label: "Move note to trash",
        className: "is-danger",
        onClick: async () => {
          await this.plugin.trashNote(path);
        },
      },
    ];
  }

  renderList(items, emptyMessage, container) {
    const list = (container || this.panelEl).createDiv({ cls: "local-start-page__list" });

    if (!items.length) {
      list.createEl("p", {
        cls: "local-start-page__empty",
        text: emptyMessage,
      });
      return;
    }

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const card = list.createDiv({ cls: "local-start-page__item" });
      const isInteractive = typeof item.onClick === "function" && !item.missing;
      const isSelected = this.selectedItems.has(item.path);
      card.setAttr("role", isInteractive ? "button" : "note");

      if (isSelected) {
        card.addClass("is-selected");
      }

      if (isInteractive) {
        card.tabIndex = 0;
      }

      if (item.badge) {
        card.createEl("span", {
          cls: "local-start-page__item-badge",
          text: item.badge,
        });
      }

      const titleRow = card.createDiv({ cls: "local-start-page__item-row" });
      titleRow.createEl("div", {
        cls: "local-start-page__item-title",
        text: item.title,
      });

      if (Array.isArray(item.actions) && item.actions.length) {
        const actionRow = titleRow.createDiv({ cls: "local-start-page__list-actions" });
        for (const action of item.actions) {
          const actionButton = actionRow.createEl("button", {
            cls: `local-start-page__list-action-button ${action.className || ""}`,
          });
          actionButton.type = "button";
          actionButton.setAttr("aria-label", action.label);
          setIcon(actionButton, action.icon);
          actionButton.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            actionButton.disabled = true;
            try {
              await action.onClick();
            } finally {
              actionButton.disabled = false;
            }
          });
        }
      }

      // Task-specific actions (for tasks tab)
      if (Array.isArray(item.taskActions) && item.taskActions.length) {
        const taskActionRow = titleRow.createDiv({ cls: "local-start-page__list-actions" });
        for (const action of item.taskActions) {
          const actionButton = taskActionRow.createEl("button", {
            cls: `local-start-page__list-action-button ${action.className || ""}`,
          });
          actionButton.type = "button";
          actionButton.setAttr("aria-label", action.label);
          setIcon(actionButton, action.icon);
          actionButton.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            actionButton.disabled = true;
            try {
              await action.onClick(event);
            } finally {
              actionButton.disabled = false;
            }
          });
        }
      }

      card.createEl("div", {
        cls: "local-start-page__item-path",
        text: item.meta || item.path,
      });

      if (item.missing) {
        card.addClass("is-missing");
      } else if (isInteractive) {
        card.addEventListener("click", (event) => {
          // Handle selection with keyboard modifiers
          this.toggleItemSelection(item.path, index, event);
          
          const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
          const ctrlOrMeta = isMac ? event.metaKey : event.ctrlKey;
          const shiftKey = event.shiftKey;
          
          // Cmd/Ctrl+Click: Open in new window (don't change selection)
          if (ctrlOrMeta) {
            event.preventDefault();
            const leaf = this.app.workspace.getLeaf(true);
            item.onClick(leaf);
            return;
          }
          
          // If not selecting (no shift modifier), also trigger the original action
          if (!shiftKey) {
            // Small delay to allow selection state to update
            setTimeout(() => item.onClick(), 0);
          }
        });
        
        card.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
            const ctrlOrMeta = isMac ? event.metaKey : event.ctrlKey;
            const shiftKey = event.shiftKey;
            
            if (shiftKey || ctrlOrMeta) {
              this.toggleItemSelection(item.path, index, event);
            } else {
              item.onClick();
            }
          }
          // Ctrl/Cmd+A to select all
          if ((event.ctrlKey || event.metaKey) && event.key === "a") {
            event.preventDefault();
            for (const i of items) {
              this.selectedItems.add(i.path);
            }
            this.renderPanel();
          }
          // Cmd/Ctrl+Enter to open selected in new windows
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && this.selectedItems.size > 1) {
            event.preventDefault();
            this.openSelectedInNewWindows();
          }
          // Escape to clear selection
          if (event.key === "Escape" && this.selectedItems.size > 0) {
            this.clearSelection();
          }
        });
      }
    }
  }
}

class LocalStartPageSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Home Page" });

    // General Settings
    containerEl.createEl("h3", { text: "General", cls: "setting-section-header" });

    new Setting(containerEl)
      .setName("Open on startup")
      .setDesc("Open Home whenever the vault layout is ready.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openOnStartup).onChange(async (value) => {
          this.plugin.settings.openOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Replace current leaf on startup")
      .setDesc("Reuse the current main tab instead of opening the home page in a new tab.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.replaceActiveLeafOnStartup).onChange(async (value) => {
          this.plugin.settings.replaceActiveLeafOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Title")
      .setDesc("Main heading shown at the top of the home page.")
      .addText((text) =>
        text.setPlaceholder("Home").setValue(this.plugin.settings.title).onChange(async (value) => {
          this.plugin.settings.title = value.trim() || DEFAULT_SETTINGS.title;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Subtitle")
      .setDesc("Short helper text below the title.")
      .addText((text) =>
        text
          .setPlaceholder("Search files and folders across your vault")
          .setValue(this.plugin.settings.subtitle)
          .onChange(async (value) => {
            this.plugin.settings.subtitle = value.trim() || DEFAULT_SETTINGS.subtitle;
            await this.plugin.saveSettings();
          })
      );

    // Display Sections
    containerEl.createEl("h3", { text: "Display Sections", cls: "setting-section-header" });
    containerEl.createEl("p", { text: "Choose which sections to show on the home page.", cls: "setting-section-description" });

    new Setting(containerEl)
      .setName("Show Recent notes")
      .setDesc("Display the Recent notes tab and list.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showRecent).onChange(async (value) => {
          this.plugin.settings.showRecent = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show Deleted notes")
      .setDesc("Display the Deleted notes tab with local trash.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showDeleted).onChange(async (value) => {
          this.plugin.settings.showDeleted = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show Pinned notes")
      .setDesc("Display the Pinned notes tab.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showPinned).onChange(async (value) => {
          this.plugin.settings.showPinned = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show Tasks")
      .setDesc("Display a Tasks tab showing incomplete tasks from the Tasks plugin (requires Tasks plugin).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showTasks).onChange(async (value) => {
          this.plugin.settings.showTasks = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show Temporary notes in Recent")
      .setDesc("Include temporary notes in the Recent notes list.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showTempNotes).onChange(async (value) => {
          this.plugin.settings.showTempNotes = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show Search bar")
      .setDesc("Display the search bar and live suggestions.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showSearch).onChange(async (value) => {
          this.plugin.settings.showSearch = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show Vault tree")
      .setDesc("Display the expandable vault folder tree on the right.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showVaultTree).onChange(async (value) => {
          this.plugin.settings.showVaultTree = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show Bookmarks panel")
      .setDesc("Display a dedicated bookmarks section on the home view.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showBookmarks).onChange(async (value) => {
          this.plugin.settings.showBookmarks = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show Favorites tray")
      .setDesc("Display a quick-access pinned notes tray on the home view.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showFavorites).onChange(async (value) => {
          this.plugin.settings.showFavorites = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Focus mode")
      .setDesc("Hide extra chrome and keep the home view minimal for focused navigation.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.focusMode).onChange(async (value) => {
          this.plugin.settings.focusMode = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show Stats cards")
      .setDesc("Display file count, notes added today, and bookmarks summary cards.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showStats).onChange(async (value) => {
          this.plugin.settings.showStats = value;
          await this.plugin.saveSettings();
        })
      );

    // Limits
    containerEl.createEl("h3", { text: "Limits", cls: "setting-section-header" });

    new Setting(containerEl)
      .setName("Recent notes limit")
      .setDesc("Maximum number of recent notes to show on the homepage (max 15).")
      .addSlider((slider) =>
        slider
          .setLimits(1, 15, 1)
          .setValue(this.plugin.settings.maxRecent)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxRecent = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Search suggestion limit")
      .setDesc("Maximum number of live search suggestions to show below the search bar.")
      .addSlider((slider) =>
        slider
          .setLimits(5, 50, 1)
          .setValue(this.plugin.settings.maxSearchResults)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxSearchResults = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max tasks to show")
      .setDesc("Maximum number of tasks to display in the Tasks tab.")
      .addSlider((slider) =>
        slider
          .setLimits(3, 30, 1)
          .setValue(this.plugin.settings.maxTasks)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxTasks = value;
            await this.plugin.saveSettings();
          })
      );

    // Tasks Settings
    containerEl.createEl("h3", { text: "Tasks", cls: "setting-section-header" });
    containerEl.createEl("p", { text: "Requires the Tasks community plugin to be installed and enabled.", cls: "setting-section-description" });

    new Setting(containerEl)
      .setName("Tasks filter query")
      .setDesc("Tasks query string to filter tasks (e.g., '#work', 'due before next week', 'not done'). Leave empty for all incomplete tasks.")
      .addText((text) =>
        text
          .setPlaceholder("#work OR due before next week")
          .setValue(this.plugin.settings.tasksFilterQuery)
          .onChange(async (value) => {
            this.plugin.settings.tasksFilterQuery = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // Temporary Notes
    containerEl.createEl("h3", { text: "Temporary Notes", cls: "setting-section-header" });

    new Setting(containerEl)
      .setName("Temporary notes folder")
      .setDesc("Folder path where temporary notes are created (relative to vault root).")
      .addText((text) =>
        text
          .setPlaceholder("temporary")
          .setValue(this.plugin.settings.tempFolder)
          .onChange(async (value) => {
            this.plugin.settings.tempFolder = value.trim() || DEFAULT_SETTINGS.tempFolder;
            await this.plugin.saveSettings();
          })
      );

    // Appearance
    containerEl.createEl("h3", { text: "Appearance", cls: "setting-section-header" });

    new Setting(containerEl)
      .setName("Compact ribbon menu")
      .setDesc("When enabled, clicking the home ribbon icon shows a compact popover menu instead of opening the full home view. Disable to always open the full view.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.compactRibbonMenu).onChange(async (value) => {
          this.plugin.settings.compactRibbonMenu = value;
          await this.plugin.saveSettings();
        })
      );

    // Homepage Header
    containerEl.createEl("h3", { text: "Homepage Header", cls: "setting-section-header" });

    new Setting(containerEl)
      .setName("Show greeting header")
      .setDesc("Display a contextual greeting block at the top of the home page.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showGreeting).onChange(async (value) => {
          this.plugin.settings.showGreeting = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Greeting title")
      .setDesc("Short title shown in the home greeting header.")
      .addText((text) =>
        text
          .setPlaceholder("Home")
          .setValue(this.plugin.settings.greetingTitle)
          .onChange(async (value) => {
            this.plugin.settings.greetingTitle = value.trim() || DEFAULT_SETTINGS.greetingTitle;
            await this.plugin.saveSettings();
          })
      );

    // Upcoming Widget
    containerEl.createEl("h3", { text: "Upcoming Widget", cls: "setting-section-header" });

    new Setting(containerEl)
      .setName("Show upcoming widget")
      .setDesc("Display a quick list of notes opened or created today on the home page.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showUpcoming).onChange(async (value) => {
          this.plugin.settings.showUpcoming = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Upcoming max items")
      .setDesc("Maximum number of today notes shown in the upcoming widget.")
      .addSlider((slider) =>
        slider
          .setLimits(3, 20, 1)
          .setValue(this.plugin.settings.upcomingMaxItems)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.upcomingMaxItems = value;
            await this.plugin.saveSettings();
          })
      );

    // Pinned Notes
    containerEl.createEl("h3", { text: "Pinned Notes", cls: "setting-section-header" });

    new Setting(containerEl)
      .setName("Pinned notes")
      .setDesc("One note per line. Use Label | path/to/note.md, or just path/to/note.md.")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text
          .setPlaceholder("Projects | Projects/Overview.md\nInbox/Today.md")
          .setValue(serializePinnedItems(this.plugin.settings.pinnedItems))
          .onChange(async (value) => {
            this.plugin.settings.pinnedItems = parsePinnedItems(value);
            await this.plugin.saveSettings();
          });
      });

    // Actions
    containerEl.createEl("h3", { text: "Actions", cls: "setting-section-header" });

    new Setting(containerEl)
      .setName("Open home page now")
      .setDesc("Open Home immediately in the current workspace.")
      .addButton((button) =>
        button.setButtonText("Open").onClick(async () => {
          await this.plugin.activateView({ replaceCurrent: false });
          new Notice("Home opened.");
        })
      );
  }
}

module.exports = class LocalStartPagePlugin extends Plugin {
  async onload() {
    this.lastClosedNotePath = null;
    this.openMarkdownPaths = new Set();
    await this.loadSettings();

    this.registerView(VIEW_TYPE_START_PAGE, (leaf) => new LocalStartPageView(leaf, this));

    // Ribbon icon, show compact menu or open full view based on settings
    this.addRibbonIcon("house", "Open home", async (evt) => {
      if (this.settings.compactRibbonMenu !== false) {
        this.showCompactHomeMenu(evt);
      } else {
        await this.activateView({ replaceCurrent: false });
      }
    });

    this.addCommand({
      id: "open-home",
      name: "Open home",
      callback: async () => {
        await this.activateView({ replaceCurrent: false });
      },
    });

    this.addCommand({
      id: "open-last-closed",
      name: "Open last closed note",
      callback: async () => {
        await this.openLastClosedNote();
      },
    });

    this.addCommand({
      id: "open-recently-closed",
      name: "Open recently closed notes",
      callback: async () => {
        await this.openRecentlyClosedNotes();
      },
    });

    this.addCommand({
      id: "focus-home-search",
      name: "Focus home search",
      callback: async () => {
        await this.activateView({ replaceCurrent: false });
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_START_PAGE)[0];
        if (leaf && leaf.view instanceof LocalStartPageView) {
          leaf.view.focusSearch();
        }
      },
    });

    this.addCommand({
      id: "create-temp-note",
      name: "Create temporary note",
      callback: async () => {
        await this.createTemporaryNote(this.app.workspace.getLeaf(true));
      },
    });

    // Embeddable dashboard note , opens the plugin home view as a leaf.
    this.addCommand({
      id: "open-embed-home-note",
      name: "Open home as dashboard note",
      callback: async ({ sourceLeaf }) => {
        await this.activateView({ replaceCurrent: !!sourceLeaf });
      },
    });

    this.addSettingTab(new LocalStartPageSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.syncClosedNoteState();
        this.maybeRestoreHomeView();
        this.tagHomeTabs();
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.syncClosedNoteState();
        this.maybeRestoreHomeView();
        this.tagHomeTabs();
      })
    );

    // NOTE: The vault event listeners that previously called refreshViews() on
    // every rename/delete/create/modify have been removed. The homepage is a fixed
    // dashboard , it must not rebuild itself spontaneously while a note is opened
    // or edited elsewhere. Explicit user actions within the homepage still call
    // refreshViews() directly, so the UI stays correct after those interactions.

    this.app.workspace.onLayoutReady(async () => {
      this.openMarkdownPaths = this.getOpenMarkdownPaths();

      if (!this.settings.openOnStartup) {
        this.maybeRestoreHomeView();
        return;
      }

      await this.activateView({ replaceCurrent: this.settings.replaceActiveLeafOnStartup });
    });
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_START_PAGE);
  }

  async loadSettings() {
    const loaded = (await this.loadData()) || {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      pinnedItems: normalizePinnedItems(loaded.pinnedItems || DEFAULT_SETTINGS.pinnedItems),
      deletedItems: normalizeDeletedItems(loaded.deletedItems || DEFAULT_SETTINGS.deletedItems),
      recentHistory: normalizeStringHistory(loaded.recentHistory),
      removedBookmarks: normalizeStringHistory(loaded.removedBookmarks),
      folderHistory: normalizeStringHistory(loaded.folderHistory),
      // Ensure boolean defaults for new settings
      showRecent: loaded.showRecent ?? DEFAULT_SETTINGS.showRecent,
      // Clamp recent-notes limit to the supported range (1..15)
      maxRecent: Math.min(15, Math.max(1, Number(loaded.maxRecent) || DEFAULT_SETTINGS.maxRecent)),
      showDeleted: loaded.showDeleted ?? DEFAULT_SETTINGS.showDeleted,
      showPinned: loaded.showPinned ?? DEFAULT_SETTINGS.showPinned,
      showTasks: loaded.showTasks ?? DEFAULT_SETTINGS.showTasks,
      showTempNotes: loaded.showTempNotes ?? DEFAULT_SETTINGS.showTempNotes,
      showSearch: loaded.showSearch ?? DEFAULT_SETTINGS.showSearch,
      showVaultTree: loaded.showVaultTree ?? DEFAULT_SETTINGS.showVaultTree,
      showStats: loaded.showStats ?? DEFAULT_SETTINGS.showStats,
      tasksFilterQuery: typeof loaded.tasksFilterQuery === "string" ? loaded.tasksFilterQuery : DEFAULT_SETTINGS.tasksFilterQuery,
      maxTasks: Number.isFinite(loaded.maxTasks) ? loaded.maxTasks : DEFAULT_SETTINGS.maxTasks,
      tasks: Array.isArray(loaded.tasks)
        ? loaded.tasks
            .filter((t) => t && typeof t.text === "string")
            .map((t) => ({ id: String(t.id || `t${Date.now()}-${Math.random().toString(36).slice(2,7)}`), text: t.text, done: Boolean(t.done), created: Number.isFinite(t.created) ? t.created : Date.now() }))
        : [],
      tempFolder: typeof loaded.tempFolder === "string" && loaded.tempFolder.trim() ? loaded.tempFolder.trim() : DEFAULT_SETTINGS.tempFolder,
      compactRibbonMenu: loaded.compactRibbonMenu ?? DEFAULT_SETTINGS.compactRibbonMenu,
    };

    if (!this.settings.title || this.settings.title === "Start" || this.settings.title === "Home Page") {
      this.settings.title = "Home";
    }

    if (!["recent", "pinned", "deleted"].includes(this.settings.defaultTab)) {
      this.settings.defaultTab = "recent";
    }

    this.settings.showGreeting = loaded.showGreeting ?? DEFAULT_SETTINGS.showGreeting;
    this.settings.greetingTitle = typeof loaded.greetingTitle === "string" && loaded.greetingTitle.trim() ? loaded.greetingTitle.trim() : DEFAULT_SETTINGS.greetingTitle;
    this.settings.showUpcoming = loaded.showUpcoming ?? DEFAULT_SETTINGS.showUpcoming;
    this.settings.upcomingMaxItems = Number.isFinite(loaded.upcomingMaxItems) ? loaded.upcomingMaxItems : DEFAULT_SETTINGS.upcomingMaxItems;
    this.settings.showBookmarks = loaded.showBookmarks ?? DEFAULT_SETTINGS.showBookmarks;
    this.settings.showFavorites = loaded.showFavorites ?? DEFAULT_SETTINGS.showFavorites;
    this.settings.layoutPreset = ["default", "focus", "minimal"].includes(loaded.layoutPreset) ? loaded.layoutPreset : DEFAULT_SETTINGS.layoutPreset;
    this.settings.focusMode = loaded.focusMode ?? DEFAULT_SETTINGS.focusMode;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshViews({ preserveScroll: true });
  }

  refreshViews(options = { preserveScroll: true }) {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_START_PAGE).forEach((leaf) => {
      if (leaf.view instanceof LocalStartPageView) {
        leaf.view.render(options);
      }
    });
  }

  maybeRestoreHomeView() {
    if (!this.app.workspace.layoutReady) {
      return;
    }

    let markdownLeafCount = 0;
    let homeLeafCount = 0;

    this.app.workspace.iterateRootLeaves((leaf) => {
      const viewType = typeof leaf.view?.getViewType === "function" ? leaf.view.getViewType() : "";
      if (viewType === "markdown") {
        markdownLeafCount += 1;
      }
      if (viewType === VIEW_TYPE_START_PAGE) {
        homeLeafCount += 1;
      }
    });

    if (markdownLeafCount === 0 && homeLeafCount === 0) {
      this.activateView({ replaceCurrent: true });
    }
  }

  // Tag every Home view's workspace tab header so CSS can shorten ONLY the Home
  // tab (left to right) without touching other tabs or windows.
  tagHomeTabs() {
    try {
      const tabHeaders = document.querySelectorAll(".workspace-tab-header");
      for (const tabHeader of tabHeaders) {
        if ((tabHeader.textContent || "").includes("Home")) {
          tabHeader.addClass("local-start-page__home-tab");
        }
      }
    } catch (e) { /* non-critical */ }
  }

  async activateView({ replaceCurrent }) {
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_START_PAGE)[0];
    const leaf = existingLeaf || (replaceCurrent && this.app.workspace.activeLeaf ? this.app.workspace.activeLeaf : this.app.workspace.getLeaf(true));

    await leaf.setViewState({
      type: VIEW_TYPE_START_PAGE,
      active: true,
    });

    this.app.workspace.revealLeaf(leaf);
  }

  getOpenMarkdownPaths() {
    const paths = new Set();

    this.app.workspace.iterateRootLeaves((leaf) => {
      const file = leaf.view && leaf.view.file;
      if (file instanceof TFile && file.extension === "md") {
        paths.add(file.path);
      }
    });

    return paths;
  }

  syncClosedNoteState() {
    const nextPaths = this.getOpenMarkdownPaths();
    const removedPaths = [...this.openMarkdownPaths].filter((path) => !nextPaths.has(path));

    if (removedPaths.length) {
      removedPaths.sort((left, right) => {
        const leftIndex = this.settings.recentHistory.indexOf(left);
        const rightIndex = this.settings.recentHistory.indexOf(right);
        const normalizedLeftIndex = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
        const normalizedRightIndex = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
        return normalizedLeftIndex - normalizedRightIndex;
      });

      const nextClosedPath = removedPaths[0];
      if (nextClosedPath && nextClosedPath !== this.lastClosedNotePath) {
        this.lastClosedNotePath = nextClosedPath;
        // Intentionally do NOT refreshViews(): the homepage must stay fixed when
        // leaves open/close elsewhere. lastClosedNotePath is still tracked so
        // "Open last note" keeps working.
      }
    }

    this.openMarkdownPaths = nextPaths;
  }

  openFile(path, sourceLeaf) {
    const target = this.app.vault.getAbstractFileByPath(path);
    if (!(target instanceof TFile)) {
      new Notice(`Unable to open ${path}`);
      return;
    }

    // Never replace the Home view itself: if no explicit leaf was given, or the
    // resolved leaf is the Home leaf, open in a brand-new leaf instead.
    const homeLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_START_PAGE);
    let leaf = sourceLeaf;
    if (!leaf || homeLeaves.includes(leaf)) {
      leaf = this.app.workspace.getLeaf(true);
    } else if (typeof leaf.openFile !== "function") {
      leaf = this.app.workspace.getLeaf(true);
    }

    leaf.openFile(target, { active: true });
  }

  getLastClosedNote() {
    const candidatePaths = [
      ...this.settings.recentHistory.filter((path) => !this.openMarkdownPaths.has(path)),
      ...this.settings.recentHistory,
      this.lastClosedNotePath,
    ].filter(Boolean);

    for (const path of candidatePaths) {
      const target = this.app.vault.getAbstractFileByPath(path);
      if (target instanceof TFile && target.extension === "md" && !this.isManagedTrashPath(target.path)) {
        return {
          path: target.path,
          title: target.basename,
        };
      }
    }

    return null;
  }

  async openLastClosedNote(sourceLeaf) {
    const lastClosed = this.getLastClosedNote();
    if (!lastClosed) {
      new Notice("No recently closed note available.");
      return;
    }

    this.openFile(lastClosed_path, sourceLeaf);
  }

  getRecentlyClosedNotes(limit = HISTORY_LIMIT) {
    const seen = new Set();
    const notes = [];

    for (const path of this.settings.recentHistory) {
      if (seen.has(path) || this.openMarkdownPaths.has(path)) {
        continue;
      }

      const target = this.app.vault.getAbstractFileByPath(path);
      if (!(target instanceof TFile) || target.extension !== "md" || this.isManagedTrashPath(target.path)) {
        continue;
      }

      seen.add(path);
      notes.push({
        path: target.path,
        title: target.basename,
      });

      if (notes.length >= limit) {
        break;
      }
    }

    return notes;
  }

  async openRecentlyClosedNotes() {
    const notes = this.getRecentlyClosedNotes();
    if (!notes.length) {
      new Notice("No recently closed notes available.");
      return;
    }

    notes.forEach((note) => {
      const leaf = this.app.workspace.getLeaf(true);
      this.openFile(note.path, leaf);
    });
  }

  async createTemporaryNote(sourceLeaf, folderPath) {
    const targetFolder = typeof folderPath === "string" && folderPath.trim() ? folderPath.trim() : this.settings.tempFolder || TEMPORARY_FOLDER;
    const existingFolder = this.app.vault.getAbstractFileByPath(targetFolder);
    if (!existingFolder) {
      await this.app.vault.createFolder(targetFolder);
    } else if (!(existingFolder instanceof TFolder)) {
      throw new Error(`A non-folder item already exists at ${targetFolder}`);
    }

    let notePath = `${targetFolder}/${UNTITLED_NOTE_NAME}.md`;
    let index = 2;

    while (this.app.vault.getAbstractFileByPath(notePath)) {
      notePath = `${targetFolder}/${UNTITLED_NOTE_NAME} ${index}.md`;
      index += 1;
    }

    const file = await this.app.vault.create(notePath, "");
    this.settings.recentHistory = [file.path, ...this.settings.recentHistory.filter((path) => path !== file.path)].slice(
      0,
      HISTORY_LIMIT
    );
    this.recordFolderAccess(targetFolder);
    await this.saveSettings();
    this.openFile(file.path, sourceLeaf);
    new Notice("Note created.");
    return file;
  }

  recordFolderAccess(path) {
    if (typeof path !== "string") {
      return;
    }

    const normalizedPath = path.trim();
    if (!normalizedPath && normalizedPath !== "") {
      return;
    }

    this.settings.folderHistory = [normalizedPath, ...this.settings.folderHistory.filter((item) => item !== normalizedPath)].slice(
      0,
      HISTORY_LIMIT
    );

    this.saveData(this.settings);
    this.refreshViews({ preserveScroll: true });
  }

  getAllFiles() {
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => !this.isManagedTrashPath(file.path))
      .map((file) => ({
        name: file.basename,
        path: file.path,
        created: file.stat.ctime,
        modified: file.stat.mtime,
      }));
  }

  getVaultRootLabel() {
    return this.app.vault.getName ? this.app.vault.getName() : "Vault root";
  }

  isManagedTrashPath(path) {
    if (typeof path !== "string") {
      return false;
    }

    return [LOCAL_TRASH_FOLDER, LEGACY_LOCAL_TRASH_FOLDER].some(
      (root) => path === root || path.startsWith(`${root}/`)
    );
  }

  isSearchablePath(path) {
    if (typeof path !== "string") {
      return false;
    }

    const configDir = this.app.vault.configDir;
    return path !== configDir && !path.startsWith(`${configDir}/`) && !this.isManagedTrashPath(path);
  }

  async ensureFolderPath(folderPath) {
    if (!folderPath) {
      return;
    }

    const segments = folderPath.split("/").filter(Boolean);
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(currentPath);
      if (!existing) {
        await this.app.vault.createFolder(currentPath);
      }
    }
  }

  async getAvailablePath(path) {
    const extensionIndex = path.lastIndexOf(".");
    const hasExtension = extensionIndex > -1;
    const directoryPath = getParentFolderPath(path);
    const baseName = hasExtension ? path.slice(0, extensionIndex) : path;
    const extension = hasExtension ? path.slice(extensionIndex) : "";
    let candidatePath = path;
    let index = 2;

    while (this.app.vault.getAbstractFileByPath(candidatePath)) {
      const suffix = ` ${index}`;
      const nextFileName = `${baseName}${suffix}${extension}`;
      candidatePath = directoryPath ? `${directoryPath}/${nextFileName.split("/").pop()}` : nextFileName;
      index += 1;
    }

    return candidatePath;
  }

  async trashNote(path) {
    const target = this.app.vault.getAbstractFileByPath(path);
    if (!(target instanceof TFile)) {
      new Notice("Could not move that note to trash.");
      return;
    }

    try {
      const desiredTrashPath = `${LOCAL_TRASH_FOLDER}/${path}`;
      const trashFolderPath = getParentFolderPath(desiredTrashPath);
      await this.ensureFolderPath(trashFolderPath);
      const trashPath = await this.getAvailablePath(desiredTrashPath);

      await this.ensureFolderPath(getParentFolderPath(trashPath));
      await this.app.fileManager.renameFile(target, trashPath);

      this.settings.deletedItems = [
        {
          originalPath: path,
          trashPath,
          deletedAt: Date.now(),
        },
        ...this.settings.deletedItems.filter((item) => item.originalPath !== path && item.trashPath !== trashPath),
      ];
      this.settings.pinnedItems = this.settings.pinnedItems.filter((item) => item.path !== path);
      this.settings.recentHistory = this.settings.recentHistory.filter((itemPath) => itemPath !== path);
      this.lastClosedNotePath = path;
      await this.saveSettings();
      new Notice("Note moved to local trash.");
    } catch (error) {
      console.error("Local Home: failed to move note to trash", error);
      new Notice("Could not move that note to trash.");
    }
  }

  getDeletedItems() {
    return this.settings.deletedItems
      .map((item) => {
        const target = this.app.vault.getAbstractFileByPath(item.trashPath);
        const title = target instanceof TFile
          ? target.basename
          : item.originalPath.split("/").pop().replace(/\.md$/, "");
        return {
          title,
          path: item.trashPath,
          meta: item.originalPath,
          badge: formatTimeAgo(item.deletedAt),
          missing: !(target instanceof TFile),
          actions: [
            {
              icon: "rotate-ccw",
              label: "Restore note",
              className: "is-restore",
              onClick: async () => {
                await this.restoreDeletedNote(item.trashPath);
              },
            },
            {
              icon: "x",
              label: "Delete permanently",
              className: "is-danger",
              onClick: async () => {
                await this.deleteDeletedNotePermanently(item.trashPath);
              },
            },
          ],
        };
      })
      .filter(Boolean);
  }

  async clearBin() {
    const items = [...this.settings.deletedItems];
    if (!items.length) return;
    for (const item of items) {
      const target = this.app.vault.getAbstractFileByPath(item.trashPath);
      if (target instanceof TFile) {
        try { await this.app.vault.delete(target); } catch (e) { /* ignore individual failures */ }
      }
    }
    this.settings.deletedItems = [];
    await this.saveSettings();
    new Notice("Bin cleared.");
  }

  async restoreDeletedNote(trashPath) {
    const deletedItem = this.settings.deletedItems.find((item) => item.trashPath === trashPath);
    if (!deletedItem) {
      new Notice("Could not find that deleted note.");
      return;
    }

    const target = this.app.vault.getAbstractFileByPath(trashPath);
    if (!(target instanceof TFile)) {
      new Notice("That deleted note is no longer available in the local trash.");
      this.settings.deletedItems = this.settings.deletedItems.filter((item) => item.trashPath !== trashPath);
      await this.saveSettings();
      return;
    }

    try {
      await this.ensureFolderPath(getParentFolderPath(deletedItem.originalPath));
      const restorePath = await this.getAvailablePath(deletedItem.originalPath);
      await this.app.fileManager.renameFile(target, restorePath);
      this.settings.deletedItems = this.settings.deletedItems.filter((item) => item.trashPath !== trashPath);
      await this.saveSettings();
      new Notice("Note restored.");
    } catch (error) {
      console.error("Local Home: failed to restore note", error);
      new Notice("Could not restore that note.");
    }
  }

  async deleteDeletedNotePermanently(trashPath) {
    try {
      const target = this.app.vault.getAbstractFileByPath(trashPath);
      if (target instanceof TFile) {
        await this.app.vault.delete(target, true);
      }

      this.settings.deletedItems = this.settings.deletedItems.filter((item) => item.trashPath !== trashPath);
      await this.saveSettings();
      new Notice("Note deleted permanently.");
    } catch (error) {
      console.error("Local Home: failed to delete note permanently", error);
      new Notice("Could not delete that note permanently.");
    }
  }

  getSearchEntries() {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((entry) => entry instanceof TFile || entry instanceof TFolder)
      .filter((entry) => entry instanceof TFolder || this.isSearchablePath(entry.path))
      .filter((entry) => !entry.path || this.isSearchablePath(entry.path))
      .map((entry) => {
        if (entry instanceof TFolder) {
          return {
            type: "folder",
            name: entry.isRoot && entry.isRoot() ? "Vault root" : entry.name,
            path: entry.path,
            childFolderCount: entry.children.filter((child) => child instanceof TFolder && this.isSearchablePath(child.path)).length,
            kindLabel: "Folder",
          };
        }

        return {
          type: "file",
          name: entry.extension === "md" ? entry.basename : entry.name,
          path: entry.path,
          modified: entry.stat.mtime,
          extension: entry.extension,
          childFolderCount: 0,
          kindLabel: entry.extension === "md" ? "Note" : entry.extension.toUpperCase(),
        };
      });
  }

  async getBookmarkItems() {
    try {
      const bookmarkPath = `${this.app.vault.configDir}/bookmarks.json`;
      const exists = await this.app.vault.adapter.exists(bookmarkPath);
      if (!exists) {
        return [];
      }

      const raw = await this.app.vault.adapter.read(bookmarkPath);
      const parsed = JSON.parse(raw);
      const flat = flattenBookmarkEntries(parsed.items, []);
      const filesByPath = new Map(this.getAllFiles().map((file) => [file.path, file]));

      return flat.map((item) => {
        const file = filesByPath.get(item.path);
        return {
          title:
            typeof item.title === "string" && item.title.trim()
              ? item.title.trim()
              : file
                ? file.name
                : item.path.split("/").pop().replace(/\.md$/, ""),
          path: item.path,
        };
      }).filter((item) => !this.settings.removedBookmarks.includes(item.path));
    } catch (error) {
      console.error("Local Start Page: failed to read bookmarks", error);
      return [];
    }
  }

  async addGlobalBookmark(path) {
    if (typeof path !== "string" || !path.trim()) return;
    const normalizedPath = path.trim();
    const bookmarkPath = `${this.app.vault.configDir}/bookmarks.json`;
    let parsed = { items: [] };
    if (await this.app.vault.adapter.exists(bookmarkPath)) {
      try {
        parsed = JSON.parse(await this.app.vault.adapter.read(bookmarkPath));
        if (!Array.isArray(parsed.items)) parsed.items = [];
      } catch (e) {
        parsed = { items: [] };
      }
    }
    // avoid duplicates
    if (parsed.items.some((it) => it && it.type === "file" && it.path === normalizedPath)) {
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    const title = file instanceof TFile ? file.basename : normalizedPath.split("/").pop().replace(/\.md$/, "");
    parsed.items.unshift({ type: "file", ctime: Date.now(), path: normalizedPath, title });
    await this.app.vault.adapter.write(bookmarkPath, JSON.stringify(parsed, null, 2));
    new Notice("Bookmarked.");
  }

  async removeGlobalBookmark(path) {
    if (typeof path !== "string" || !path.trim()) return;
    const normalizedPath = path.trim();
    const bookmarkPath = `${this.app.vault.configDir}/bookmarks.json`;
    if (!(await this.app.vault.adapter.exists(bookmarkPath))) return;
    try {
      const parsed = JSON.parse(await this.app.vault.adapter.read(bookmarkPath));
      if (!Array.isArray(parsed.items)) return;
      parsed.items = parsed.items.filter((it) => !(it && it.type === "file" && it.path === normalizedPath));
      await this.app.vault.adapter.write(bookmarkPath, JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.error("Local Start Page: failed to remove bookmark", e);
    }
  }

  getNotesAddedInLastDay() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return this.getAllFiles().filter((file) => Number.isFinite(file.created) && file.created >= cutoff).length;
  }

  getFolderNoteCounts() {
    const counts = new Map();

    for (const file of this.getAllFiles()) {
      let folderPath = getParentFolderPath(file.path);
      while (folderPath !== null) {
        const key = folderPath || "";
        counts.set(key, (counts.get(key) || 0) + 1);
        folderPath = folderPath ? getParentFolderPath(folderPath) : null;
      }
    }

    return counts;
  }

  getAvailableNoteFolders() {
    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((entry) => entry instanceof TFolder)
      .filter((folder) => !folder.path || this.isSearchablePath(folder.path));

    return folders.map((folder) => ({
      title: folder.path === "" ? this.getVaultRootLabel() : folder.name,
      path: folder.path,
    }));
  }

  getRecentFolderItems(limit = 4) {
    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((entry) => entry instanceof TFolder)
      .filter((folder) => !folder.path || this.isSearchablePath(folder.path));

    const noteCounts = this.getFolderNoteCounts();

    const byPath = new Map(folders.map((folder) => [folder.path, folder]));
    const seen = new Set();
    const recentPaths = [];

    for (const path of [...this.settings.folderHistory, ...this.settings.recentHistory.map((path) => getParentFolderPath(path) || "")]) {
      if (seen.has(path)) {
        continue;
      }

      if (path !== "" && !byPath.has(path)) {
        continue;
      }

      seen.add(path);
      recentPaths.push(path);
      if (recentPaths.length >= limit) {
        break;
      }
    }

    return recentPaths.map((path) => {
      const folder = byPath.get(path);
      return {
        title: path === "" ? "Vault root" : folder ? folder.name : path.split("/").pop(),
        path,
        noteCount: noteCounts.get(path) || 0,
      };
    });
  }

  getRecentItems() {
    const filesByPath = new Map(this.getAllFiles().map((file) => [file.path, file]));
    const recentFiles = this.settings.recentHistory
      .map((path) => filesByPath.get(path))
      .filter(Boolean)
      .slice(0, this.settings.maxRecent);

    const fallback = recentFiles.length
      ? recentFiles
      : this.getAllFiles()
          .sort((left, right) => right.modified - left.modified)
          .slice(0, this.settings.maxRecent);

    return fallback.map((file) => ({
      title: file.name,
      path: file.path,
      meta: file.path,
      badge: formatTimeAgo(file.modified),
      onClick: () => this.openFileNew(file.path),
      pinPath: file.path,
    }));
  }

  searchVaultEntries(query, limit = Number.POSITIVE_INFINITY) {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const results = this.getSearchEntries()
      .map((entry) => ({
        ...entry,
        score: scoreVaultEntryMatch(entry, normalizedQuery),
      }))
      .filter((entry) => Number.isFinite(entry.score))
      .sort(
        (left, right) =>
          left.score - right.score ||
          left.name.localeCompare(right.name) ||
          left.path.localeCompare(right.path)
      );

    if (!Number.isFinite(limit)) {
      return results;
    }

    return results.slice(0, limit);
  }

  getFolderItems(activeFolderPath = null) {
    const noteCounts = this.getFolderNoteCounts();
    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((entry) => entry instanceof TFolder)
      .filter((folder) => !folder.path || this.isSearchablePath(folder.path));

    if (activeFolderPath !== null) {
      const folder = folders.find((entry) => entry.path === activeFolderPath);
      if (!folder) {
        return {
          status: "Folder not found",
          emptyMessage: "That folder is no longer available.",
          items: [
            {
              title: "Back to folders",
              path: "",
              meta: "Return to the folder overview",
              badge: "Back",
              backPath: null,
            },
          ],
        };
      }

      const parentPath = getParentFolderPath(folder.path);
      const items = [];

      if (parentPath !== null) {
        items.push({
          title: "Back",
          path: parentPath,
          meta: parentPath || this.getVaultRootLabel(),
          badge: "Up",
          backPath: parentPath,
        });
      }

      const childFolders = folder.children
        .filter((child) => child instanceof TFolder && this.isSearchablePath(child.path))
        .sort((left, right) => left.name.localeCompare(right.name));

      for (const child of childFolders) {
        const noteCount = noteCounts.get(child.path) || 0;
        items.push({
          title: child.name,
          path: child.path,
          meta: child.path,
          badge: `${noteCount} note${noteCount === 1 ? "" : "s"}`,
          folderPath: child.path,
        });
      }

      const childFiles = folder.children
        .filter((child) => child instanceof TFile)
        .filter((child) => this.isSearchablePath(child.path))
        .sort((left, right) => left.name.localeCompare(right.name));

      for (const child of childFiles) {
        items.push({
          title: child.extension === "md" ? child.basename : child.name,
          path: child.path,
          meta: child.path,
          badge: child.extension === "md" ? formatTimeAgo(child.stat.mtime) : child.extension.toUpperCase(),
          filePath: child.path,
        });
      }

      const visibleItemCount = items.length - (parentPath !== null ? 1 : 0);
      return {
        status: `${visibleItemCount} item${visibleItemCount === 1 ? "" : "s"} in ${folder.path || this.getVaultRootLabel()}`,
        emptyMessage: "This folder is empty.",
        items,
      };
    }

    const items = folders
      .filter((folder) => folder.path)
      .sort(
        (left, right) =>
          (noteCounts.get(right.path) || 0) - (noteCounts.get(left.path) || 0) ||
          left.path.localeCompare(right.path)
      )
      .map((folder) => {
        const noteCount = noteCounts.get(folder.path) || 0;
        return {
          title: folder.name,
          path: folder.path,
          meta: folder.path,
          badge: `${noteCount} note${noteCount === 1 ? "" : "s"}`,
          folderPath: folder.path,
        };
      });

    return {
      status: items.length === 0 ? "No folders yet" : `${items.length} folder${items.length === 1 ? "" : "s"}`,
      emptyMessage: "Create folders and they will appear here.",
      items,
    };
  }

  getPinnedItems() {
    const filesByPath = new Map(this.getAllFiles().map((file) => [file.path, file]));

    return this.settings.pinnedItems.map((item) => {
      const file = filesByPath.get(item.path);
      const title = item.label || (file ? file.name : item.path.split("/").pop().replace(/\.md$/, ""));

      if (!file) {
        return {
          title,
          path: item.path,
          meta: item.path,
          badge: "Missing",
          missing: true,
        };
      }

      return {
        title,
        path: file.path,
        meta: file.path,
        badge: "Pinned",
        onClick: () => this.openFileNew(file.path),
        pinPath: file.path,
      };
    });
  }

  isPinnedPath(path) {
    return this.settings.pinnedItems.some((item) => item.path === path);
  }

  async togglePinnedItem(path, label = "") {
    if (typeof path !== "string") {
      return;
    }

    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return;
    }

    if (this.isPinnedPath(normalizedPath)) {
      this.settings.pinnedItems = this.settings.pinnedItems.filter((item) => item.path !== normalizedPath);
    } else {
      this.settings.pinnedItems = [
        ...this.settings.pinnedItems,
        {
          label: typeof label === "string" ? label.trim() : "",
          path: normalizedPath,
        },
      ];
    }

    await this.saveSettings();
  }

  async removeBookmarkHint(path) {
    if (typeof path !== "string" || !path.trim()) {
      return;
    }
    const normalizedPath = path.trim();
    if (!this.settings.removedBookmarks.includes(normalizedPath)) {
      this.settings.removedBookmarks = [...this.settings.removedBookmarks, normalizedPath];
      await this.saveSettings();
    }
    // also remove from the global Obsidian bookmarks so it is truly gone
    await this.removeGlobalBookmark(normalizedPath);
  }

  getRecentItems(includeTempNotes = true) {
    const filesByPath = new Map(this.getAllFiles().map((file) => [file.path, file]));
    const tempFolder = this.settings.tempFolder || TEMPORARY_FOLDER;

    const recentFiles = this.settings.recentHistory
      .map((path) => filesByPath.get(path))
      .filter(Boolean)
      .filter((file) => {
        if (includeTempNotes) return true;
        // Exclude temp notes if setting is disabled
        return !file.path.startsWith(`${tempFolder}/`);
      })
      .slice(0, this.settings.maxRecent);

    const fallback = recentFiles.length
      ? recentFiles
      : this.getAllFiles()
          .filter((file) => {
            if (includeTempNotes) return true;
            return !file.path.startsWith(`${tempFolder}/`);
          })
          .sort((left, right) => right.modified - left.modified)
          .slice(0, this.settings.maxRecent);

    return fallback.map((file) => ({
      title: file.name,
      path: file.path,
      meta: file.path,
      badge: formatTimeAgo(file.modified),
      onClick: () => this.openFileNew(file.path),
      pinPath: file.path,
    }));
  }

  getTaskItems(limit = 10, filterQuery = "") {
    try {
      // Access the Tasks plugin API
      const tasksPlugin = this.app.plugins?.plugins?.["obsidian-tasks-plugin"];
      if (!tasksPlugin || typeof tasksPlugin.getTasks !== "function") {
        return [{
          title: "Tasks plugin not installed",
          path: "",
          meta: "Install the Tasks community plugin to see tasks here",
          badge: "Missing",
          missing: true,
        }];
      }

      const allTasks = tasksPlugin.getTasks();
      if (!Array.isArray(allTasks) || !allTasks.length) {
        return [{
          title: "No tasks found",
          path: "",
          meta: "Create tasks in your notes using the Tasks plugin syntax",
          badge: "Empty",
          missing: true,
        }];
      }

      // Filter incomplete tasks
      let tasks = allTasks.filter((task) => !task.isDone);

      // Apply filter query if provided (basic filtering)
      if (filterQuery && typeof filterQuery === "string" && filterQuery.trim()) {
        const query = filterQuery.trim().toLowerCase();
        // Simple tag filtering support
        if (query.startsWith("#")) {
          const tag = query.slice(1);
          tasks = tasks.filter((task) => task.tags?.some((t) => t.toLowerCase().includes(tag)));
        }
        // Basic text search in description
        else {
          tasks = tasks.filter((task) => task.description?.toLowerCase().includes(query));
        }
      }

      // Sort by priority (high first), then due date, then scheduled date
      tasks.sort((a, b) => {
        const priorityOrder = { high: 3, medium: 2, low: 1, none: 0 };
        const aPriority = priorityOrder[a.priority] || 0;
        const bPriority = priorityOrder[b.priority] || 0;
        if (bPriority !== aPriority) return bPriority - aPriority;

        // Due date sorting (earlier first)
        if (a.dueDate && b.dueDate) {
          return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
        }
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;

        // Scheduled date
        if (a.scheduledDate && b.scheduledDate) {
          return new Date(a.scheduledDate).getTime() - new Date(b.scheduledDate).getTime();
        }
        if (a.scheduledDate) return -1;
        if (b.scheduledDate) return 1;

        return 0;
      });

      const limitedTasks = tasks.slice(0, limit);

      return limitedTasks.map((task) => {
        const filePath = task.taskLocation?.path;
        const lineNumber = task.taskLocation?._lineNumber;
        const dueText = task.dueDate ? `📅 ${new Date(task.dueDate).toLocaleDateString()}` : "";
        const priorityIcon = task.priority === "high" ? "🔴" : task.priority === "medium" ? "🟡" : task.priority === "low" ? "🟢" : "";
        const statusIcon = task.isDone ? "✅" : "☐";

        return {
          title: `${statusIcon} ${task.description}${priorityIcon ? ` ${priorityIcon}` : ""}`,
          path: filePath,
          meta: filePath ? `${filePath}${lineNumber ? `:${lineNumber}` : ""}${dueText ? ` • ${dueText}` : ""}` : "No file path",
          badge: dueText || task.scheduledDate ? `📅 ${new Date(task.dueDate || task.scheduledDate).toLocaleDateString()}` : task.priority ? `Priority: ${task.priority}` : "No due date",
          missing: !filePath,
          onClick: filePath ? () => {
            this.openFileNew(filePath);
            // Optionally scroll to line number
            if (lineNumber) {
              setTimeout(() => {
                const leaf = this.app.workspace.getMostRecentLeaf();
                if (leaf?.view?.editor) {
                  leaf.view.editor.setCursor(lineNumber - 1, 0);
                }
              }, 100);
            }
          } : undefined,
          // Task-specific actions
          taskActions: filePath ? [
            {
              icon: task.isDone ? "rotate-ccw" : "check",
              label: task.isDone ? "Mark as incomplete" : "Mark as complete",
              onClick: async (e) => {
                e.preventDefault();
                e.stopPropagation();
                await this.toggleTaskDone(task);
              },
            },
            {
              icon: "file-text",
              label: "Open in new tab",
              onClick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                const leaf = this.app.workspace.getLeaf(true);
                this.openFile(filePath, leaf);
              },
            },
            {
              icon: "copy",
              label: "Copy task text",
              onClick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                navigator.clipboard.writeText(task.description);
                new Notice("Task text copied");
              },
            },
          ] : [],
          task: task, // Store original task for potential future actions
        };
      });
    } catch (error) {
      console.error("Local Home Page: failed to fetch tasks", error);
      return [{
        title: "Error loading tasks",
        path: "",
        meta: error.message || "Unknown error",
        badge: "Error",
        missing: true,
      }];
    }
  }

  // Local, self-contained task list (no external plugin required)
  genTaskId() {
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async addTask(text) {
    const clean = typeof text === "string" ? text.trim() : "";
    if (!clean) return;
    this.settings.tasks = [
      ...this.settings.tasks,
      { id: this.genTaskId(), text: clean, done: false, created: Date.now() },
    ];
    await this.saveSettings();
    new Notice("Task added");
  }

  async removeTask(id) {
    this.settings.tasks = this.settings.tasks.filter((t) => t.id !== id);
    await this.saveSettings();
  }

  async toggleLocalTask(id) {
    this.settings.tasks = this.settings.tasks.map((t) =>
      t.id === id ? { ...t, done: !t.done } : t
    );
    await this.saveSettings();
  }

  async reorderTasks(orderedIds) {
    if (!Array.isArray(orderedIds)) return;
    const byId = new Map(this.settings.tasks.map((t) => [t.id, t]));
    const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    // keep any tasks not present in orderedIds (safety)
    for (const t of this.settings.tasks) {
      if (!orderedIds.includes(t.id)) reordered.push(t);
    }
    this.settings.tasks = reordered;
    await this.saveSettings();
  }

  async toggleTaskDone(task) {
    try {
      const tasksPlugin = this.app.plugins?.plugins?.["obsidian-tasks-plugin"];
      if (!tasksPlugin || typeof tasksPlugin.executeToggleTaskDoneCommand !== "function") {
        new Notice("Tasks plugin doesn't support toggling via API");
        return;
      }

      // Get the original markdown line for the task
      const originalLine = task.originalMarkdown || task.description;
      const filePath = task.taskLocation?.path;

      if (!filePath) {
        new Notice("Cannot find task file");
        return;
      }

      // Toggle the task
      const newLine = tasksPlugin.executeToggleTaskDoneCommand(originalLine, filePath);

      // Read the file and replace the line
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        const content = await this.app.vault.read(file);
        const lines = content.split("\n");
        const lineIndex = lines.findIndex(l => l.trim() === originalLine.trim()) || (task.taskLocation?._lineNumber ? task.taskLocation._lineNumber - 1 : -1);

        if (lineIndex >= 0) {
          lines[lineIndex] = newLine;
          await this.app.vault.modify(file, lines.join("\n"));
          new Notice(task.isDone ? "Task marked incomplete" : "Task completed");
          this.renderPanel(); // Refresh the tasks list
        } else {
          new Notice("Could not locate task in file");
        }
      }
    } catch (error) {
      console.error("Failed to toggle task:", error);
      new Notice("Failed to toggle task");
    }
  }

  getGreetingText() {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    return "Good evening";
  }

  showCompactHomeMenu(evt) {
    const { Menu, setIcon } = require("obsidian");
    const menu = new Menu();

    // Search action
    menu.addItem((item) => {
      item
        .setTitle("Search vault")
        .setIcon("search")
        .onClick(() => {
          this.activateView({ replaceCurrent: false }).then(() => {
            const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_START_PAGE)[0];
            if (leaf && leaf.view instanceof LocalStartPageView) {
              leaf.view.focusSearch();
            }
          });
        });
    });

    menu.addSeparator();

    // Recent notes
    const recentItems = this.getRecentItems(this.settings.showTempNotes !== false).slice(0, 8);
    if (recentItems.length) {
      menu.addItem((item) => {
        item.setTitle("Recent notes").setIcon("clock").setDisabled(true);
      });
      for (const note of recentItems) {
        menu.addItem((item) => {
          item
            .setTitle(note.title)
            .setIcon("file-text")
            .onClick(() => this.openFile(note.path));
        });
      }
    } else {
      menu.addItem((item) => {
        item.setTitle("No recent notes").setDisabled(true);
      });
    }

    menu.addSeparator();

    // Pinned notes
    const pinnedItems = this.getPinnedItems().slice(0, 6);
    if (pinnedItems.length) {
      menu.addItem((item) => {
        item.setTitle("Pinned notes").setIcon("pin").setDisabled(true);
      });
      for (const note of pinnedItems) {
        if (!note.missing) {
          menu.addItem((item) => {
            item
              .setTitle(note.title)
              .setIcon("pin")
              .onClick(() => this.openFile(note.path));
          });
        }
      }
    }

    menu.addSeparator();

    // Tasks (if enabled)
    if (this.settings.showTasks !== false) {
      const taskItems = this.getTaskItems(5, this.settings.tasksFilterQuery);
      if (taskItems.length && !taskItems[0].missing) {
        menu.addItem((item) => {
          item.setTitle("Tasks").setIcon("check-square").setDisabled(true);
        });
        for (const task of taskItems) {
          menu.addItem((item) => {
            item
              .setTitle(task.title)
              .setIcon("check-square")
              .onClick(() => {
                if (task.path) this.openFile(task.path);
              });
          });
        }
        menu.addSeparator();
      }
    }

    // Quick actions
    menu.addItem((item) => {
      item
        .setTitle("Create temporary note")
        .setIcon("plus")
        .onClick(() => this.createTemporaryNote(this.app.workspace.getLeaf(true)));
    });

    menu.addItem((item) => {
      item
        .setTitle("Open last closed note")
        .setIcon("rotate-ccw")
        .setDisabled(!this.getLastClosedNote())
        .onClick(() => this.openLastClosedNote());
    });

    menu.addItem((item) => {
      item
        .setTitle("Open full home view")
        .setIcon("window")
        .onClick(() => this.activateView({ replaceCurrent: false }));
    });

    menu.addSeparator();

    menu.addItem((item) => {
      item
        .setTitle("Settings")
        .setIcon("settings")
        .onClick(() => {
          this.app.setting.open();
          this.app.setting.openTabById("simple-home");
        });
    });

    menu.showAtMouseEvent(evt);
  }
};