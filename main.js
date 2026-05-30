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
  folderHistory: [],
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
    const hero = shell.createDiv({ cls: "local-start-page__hero" });

    const heroHeader = hero.createDiv({ cls: "local-start-page__hero-header" });
    const heroHeading = heroHeader.createDiv({ cls: "local-start-page__hero-heading" });
    const heroActions = heroHeader.createDiv({ cls: "local-start-page__hero-actions" });

    heroHeading.createEl("p", {
      cls: "local-start-page__eyebrow",
      text: "Welcome",
    });
    heroHeading.createEl("h1", { text: this.plugin.settings.title || "Home" });
    heroHeading.createEl("p", {
      cls: "local-start-page__subtitle",
      text: this.plugin.settings.subtitle || "Search files and folders across your vault",
    });

    const lastClosed = this.plugin.getLastClosedNote();
    const reopenButton = heroActions.createEl("button", {
      cls: "local-start-page__reopen-button",
      text: "Open last closed note",
    });
    reopenButton.type = "button";
    reopenButton.disabled = !lastClosed;
    reopenButton.title = lastClosed
      ? `${lastClosed.path}\nCmd/Ctrl+Click: open recently closed notes`
      : "Cmd/Ctrl+Click: open recently closed notes";
    reopenButton.addEventListener("click", async (event) => {
      reopenButton.disabled = true;
      try {
        if (event.metaKey || event.ctrlKey) {
          await this.plugin.openRecentlyClosedNotes();
        } else {
          await this.plugin.openLastClosedNote(this.leaf);
        }
      } finally {
        reopenButton.disabled = false;
      }
    });

    const tempButton = heroActions.createEl("button", {
      cls: "local-start-page__temp-note-button",
      text: "Create temporary note",
    });
    tempButton.type = "button";
    tempButton.title = "Click: create temporary note\nCmd/Ctrl+Click: create temporary note in new tab";
    tempButton.addEventListener("click", async (event) => {
      tempButton.disabled = true;
      try {
        const targetLeaf = event.metaKey || event.ctrlKey ? this.app.workspace.getLeaf(true) : this.leaf;
        await this.plugin.createTemporaryNote(targetLeaf);
      } catch (error) {
        console.error("Local Home Page: failed to create temporary note", error);
        new Notice("Could not create a temporary note.");
      } finally {
        tempButton.disabled = false;
      }
    });

    hero.createEl("h2", { cls: "local-start-page__outline-anchor", text: "Search" });
    const searchRow = hero.createDiv({ cls: "local-start-page__search" });
    const searchWrap = searchRow.createDiv({ cls: "local-start-page__search-wrap" });
    this.searchComponent = new SearchComponent(searchWrap);
    this.searchComponent.setPlaceholder("Search files and folders");
    this.searchComponent.setValue(this.query);
    this.inputEl = this.searchComponent.inputEl;

    this.suggestionEl = hero.createDiv({ cls: "local-start-page__suggestions" });
    this.suggestionEl.hide();

    const recentFolders = this.plugin.getRecentFolderItems(4);
    if (recentFolders.length) {
      const folderSection = hero.createDiv({ cls: "local-start-page__folder-strip" });
      const folderHeader = folderSection.createDiv({ cls: "local-start-page__section-header" });
      folderHeader.createEl("h2", {
        cls: "local-start-page__section-label",
        text: "Recent folders",
      });
      folderHeader.createEl("p", {
        cls: "local-start-page__section-copy",
        text: "Jump back into the places you opened most recently.",
      });

      const folderGrid = folderSection.createDiv({ cls: "local-start-page__folder-grid" });
      for (const folder of recentFolders) {
        const card = folderGrid.createDiv({ cls: "local-start-page__folder-card" });
        card.tabIndex = 0;
        card.setAttr("role", "button");

        const iconWrap = card.createDiv({ cls: "local-start-page__folder-icon" });
        setIcon(iconWrap, "folder");

        card.createEl("div", {
          cls: "local-start-page__folder-title",
          text: folder.title,
        });
        card.createEl("div", {
          cls: "local-start-page__folder-meta",
          text: folder.path || this.plugin.getVaultRootLabel(),
        });
        card.createEl("div", {
          cls: "local-start-page__folder-badge",
          text: `${folder.noteCount} note${folder.noteCount === 1 ? "" : "s"}`,
        });

        const onRevealFolder = () => this.focusTreeFolder(folder.path);
        card.addEventListener("click", onRevealFolder);
        card.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onRevealFolder();
          }
        });
      }
    }

    hero.createEl("h2", { cls: "local-start-page__outline-anchor", text: "Overview" });
    const summaryGrid = hero.createDiv({ cls: "local-start-page__summary-grid" });
    this.renderSummaries(summaryGrid);

    const tabsRow = shell.createDiv({ cls: "local-start-page__tabs-row" });
    const tabs = tabsRow.createDiv({ cls: "local-start-page__tabs" });
    const tabDefs = [
      { id: "recent", label: "Recent" },
      { id: "deleted", label: "Deleted" },
      { id: "pinned", label: "Pinned" },
    ];

    this.tabButtons.clear();
    for (const tab of tabDefs) {
      const button = tabs.createEl("button", {
        cls: "local-start-page__tab",
        text: tab.label,
      });
      button.type = "button";
      button.addEventListener("click", () => {
        this.activeTab = tab.id;
        this.resetSearch();
        this.activeFolderPath = null;
        this.renderPanel();
      });
      this.tabButtons.set(tab.id, button);
    }

    const workspaceGrid = shell.createDiv({ cls: "local-start-page__workspace-grid" });

    const panel = workspaceGrid.createDiv({ cls: "local-start-page__panel" });
    this.statusEl = panel.createEl("p", { cls: "local-start-page__status" });
    this.panelEl = panel.createDiv({ cls: "local-start-page__panel-body" });

    const treePanel = workspaceGrid.createDiv({ cls: "local-start-page__tree-panel" });
    const treeHeader = treePanel.createDiv({ cls: "local-start-page__tree-header" });
    treeHeader.createEl("h2", {
      cls: "local-start-page__summary-label",
      text: "Vault tree",
    });
    treeHeader.createEl("p", {
      cls: "local-start-page__tree-copy",
      text: "Expand folders to browse notes without relying on the sidebar.",
    });
    this.treeBodyEl = treePanel.createDiv({ cls: "local-start-page__tree-body" });
    this.renderFileTree(this.treeBodyEl);

    this.searchComponent.onChange((value) => {
      this.query = value;
      this.selectedSuggestionIndex = 0;
      this.renderSuggestions();
      this.renderPanel();
    });

    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        if (!this.currentSuggestions.length) {
          return;
        }

        event.preventDefault();
        this.selectedSuggestionIndex = Math.min(
          this.currentSuggestions.length - 1,
          this.selectedSuggestionIndex + 1
        );
        this.renderSuggestions();
        return;
      }

      if (event.key === "ArrowUp") {
        if (!this.currentSuggestions.length) {
          return;
        }

        event.preventDefault();
        this.selectedSuggestionIndex = Math.max(0, this.selectedSuggestionIndex - 1);
        this.renderSuggestions();
        return;
      }

      if (event.key === "Escape") {
        this.currentSuggestions = [];
        this.renderSuggestions();
        return;
      }

      if (event.key !== "Enter") {
        return;
      }

      const match = this.currentSuggestions[this.selectedSuggestionIndex] || this.plugin.searchVaultEntries(this.query, 1)[0];
      if (!match) {
        return;
      }

      event.preventDefault();
      this.activateSearchEntry(match);
    });

    this.searchComponent.clearButtonEl.addEventListener("click", () => {
      this.query = "";
      this.currentSuggestions = [];
      this.selectedSuggestionIndex = 0;
      this.renderSuggestions();
      this.renderPanel();
    });

    this.renderSuggestions();
    this.renderPanel();

    if (preserveScroll) {
      contentEl.scrollTop = previousScrollTop;
    }

    if (focusSearch) {
      window.setTimeout(() => this.focusSearch(), 0);
    }
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

    const iconWrap = button.createSpan({ cls: "local-start-page__tree-node-icon" });
    setIcon(iconWrap, "file-text");
    button.createSpan({
      cls: "local-start-page__tree-node-label",
      text: file.extension === "md" ? file.basename : file.name,
    });

    button.addEventListener("click", () => this.plugin.openFile(file.path, this.leaf));
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
      button.addEventListener("click", () => this.plugin.openFile(bookmark.path, this.leaf));
    }
  }

  renderPanel() {
    if (!this.panelEl || !this.statusEl) {
      return;
    }

    this.panelEl.empty();

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
        deletedItems.length === 0 ? "No deleted notes" : `${deletedItems.length} deleted note${deletedItems.length === 1 ? "" : "s"}`
      );
      this.renderList(deletedItems, "Deleted notes will appear here until you restore or remove them permanently.");
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

    const recentItems = this.plugin.getRecentItems();
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

  renderList(items, emptyMessage) {
    const list = this.panelEl.createDiv({ cls: "local-start-page__list" });

    if (!items.length) {
      list.createEl("p", {
        cls: "local-start-page__empty",
        text: emptyMessage,
      });
      return;
    }

    for (const item of items) {
      const card = list.createDiv({ cls: "local-start-page__item" });
      const isInteractive = typeof item.onClick === "function" && !item.missing;
      card.setAttr("role", isInteractive ? "button" : "note");

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
        const actionRow = titleRow.createDiv({ cls: "local-start-page__item-actions" });
        for (const action of item.actions) {
          const actionButton = actionRow.createEl("button", {
            cls: "local-start-page__action-button",
          });
          actionButton.type = "button";
          actionButton.setAttr("aria-label", action.label);
          if (action.className) {
            actionButton.addClass(action.className);
          }
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

      card.createEl("div", {
        cls: "local-start-page__item-path",
        text: item.meta || item.path,
      });

      if (item.missing) {
        card.addClass("is-missing");
      } else if (isInteractive) {
        card.addEventListener("click", item.onClick);
        card.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            item.onClick();
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

    containerEl.createEl("h2", { text: "Home" });

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

    new Setting(containerEl)
      .setName("Default tab")
      .setDesc("Which tab to show when no search query is active.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("recent", "Recent")
          .addOption("deleted", "Deleted")
          .addOption("pinned", "Pinned")
          .setValue(this.plugin.settings.defaultTab)
          .onChange(async (value) => {
            this.plugin.settings.defaultTab = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Recent notes limit")
      .setDesc("Maximum number of recent notes to show.")
      .addSlider((slider) =>
        slider
          .setLimits(4, 20, 1)
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
          .setLimits(5, 40, 1)
          .setValue(this.plugin.settings.maxSearchResults)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxSearchResults = value;
            await this.plugin.saveSettings();
          })
      );

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

    this.addRibbonIcon("house", "Open home", async () => {
      await this.activateView({ replaceCurrent: false });
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
      id: "create-temp-note",
      name: "Create temporary note",
      callback: async () => {
        await this.createTemporaryNote(this.app.workspace.getLeaf(true));
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

    this.addSettingTab(new LocalStartPageSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.syncClosedNoteState();
        this.maybeRestoreHomeView();
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.syncClosedNoteState();
        this.maybeRestoreHomeView();
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", async (file) => {
        if (!file || file.extension !== "md") {
          return;
        }

        const nextHistory = [file.path, ...this.settings.recentHistory.filter((path) => path !== file.path)].slice(
          0,
          HISTORY_LIMIT
        );

        this.settings.recentHistory = nextHistory;
        const folderPath = getParentFolderPath(file.path) || "";
        this.settings.folderHistory = [folderPath, ...this.settings.folderHistory.filter((path) => path !== folderPath)].slice(
          0,
          HISTORY_LIMIT
        );
        await this.saveData(this.settings);
        this.refreshViews();
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", () => {
        this.refreshViews();
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", () => {
        this.refreshViews();
      })
    );

    this.registerEvent(
      this.app.vault.on("create", () => {
        this.refreshViews();
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!file) {
          return;
        }

        const bookmarkPath = `${this.app.vault.configDir}/bookmarks.json`;
        if (file.path === bookmarkPath || file.extension === "md") {
          this.refreshViews();
        }
      })
    );

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
      folderHistory: normalizeStringHistory(loaded.folderHistory),
    };

    if (!this.settings.title || this.settings.title === "Start" || this.settings.title === "Home Page") {
      this.settings.title = "Home";
    }

    if (!["recent", "pinned", "deleted"].includes(this.settings.defaultTab)) {
      this.settings.defaultTab = "recent";
    }
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
        this.refreshViews();
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

    const leaf = sourceLeaf || this.app.workspace.getMostRecentLeaf() || this.app.workspace.getLeaf(false);
    if (!leaf || typeof leaf.openFile !== "function") {
      this.app.workspace.openLinkText(path, "", false, { active: true });
      return;
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

    this.openFile(lastClosed.path, sourceLeaf);
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

  async createTemporaryNote(sourceLeaf) {
    const folderPath = TEMPORARY_FOLDER;
    const existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!existingFolder) {
      await this.app.vault.createFolder(folderPath);
    } else if (!(existingFolder instanceof TFolder)) {
      throw new Error("A non-folder item already exists at temporary");
    }

    let notePath = `${folderPath}/${UNTITLED_NOTE_NAME}.md`;
    let index = 2;

    while (this.app.vault.getAbstractFileByPath(notePath)) {
      notePath = `${folderPath}/${UNTITLED_NOTE_NAME} ${index}.md`;
      index += 1;
    }

    const file = await this.app.vault.create(notePath, "");
    this.recordFolderAccess(folderPath);
    this.openFile(file.path, sourceLeaf);
    new Notice("Temporary note created.");
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
      });
    } catch (error) {
      console.error("Local Start Page: failed to read bookmarks", error);
      return [];
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
      onClick: () => this.openFile(file.path),
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
        onClick: () => this.openFile(file.path),
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
};