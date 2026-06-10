import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import type CopyousExtension from '../../extension.js';
import { CLIPBOARD_PAGE_SIZE, ItemType } from '../common/constants.js';
import { ClipboardEntry, LinkMetadata } from '../database/database.js';
import { formatFile } from './items/fileItem.js';
import { SearchChange, SearchQuery } from './searchEntry.js';

function isSearchActive(query: SearchQuery): boolean {
	return (
		query.query.length > 0 ||
		query.pinned ||
		query.excludePinned ||
		query.tag !== null ||
		query.excludeTagged ||
		query.type !== null
	);
}

function entryMatchesSearch(query: SearchQuery, entry: ClipboardEntry): boolean {
	switch (entry.type) {
		case ItemType.Text:
		case ItemType.Code:
		case ItemType.Character:
		case ItemType.Color:
			return query.matchesEntry(false, entry, entry.content);
		case ItemType.Image:
			return query.matchesEntry(false, entry);
		case ItemType.File: {
			const file = entry.content.substring('file://'.length);
			const formatted = formatFile(Gio.File.new_for_uri(entry.content));
			return query.matchesEntry(false, entry, file, formatted);
		}
		case ItemType.Files: {
			const files = entry.content.split('\n').map((path) => path.toLowerCase());
			const formatted = files.map((path) => {
				try {
					return formatFile(Gio.File.new_for_path(path)).toLowerCase();
				} catch {
					return path;
				}
			});
			return query.matchesEntry(false, entry, ...files, ...formatted);
		}
		case ItemType.Link: {
			const metadata: LinkMetadata = { title: null, description: null, image: null, ...entry.metadata };
			const searchTexts = [entry.content];
			if (metadata.title) searchTexts.push(metadata.title);
			if (metadata.description) searchTexts.push(metadata.description);
			return query.matchesEntry(false, entry, ...searchTexts);
		}
		default:
			return query.matchesEntry(false, entry, entry.content);
	}
}

export class ClipboardListLoader {
	private _offset = 0;
	private _loading = false;
	private _hasMore = true;
	private _totalCount = 0;
	private _loadedIds = new Set<number>();
	private _searchMode = false;
	private _searchQuery: SearchQuery | null = null;
	private _searchScanOffset = 0;
	private _generation = 0;

	constructor(
		private ext: CopyousExtension,
		private addEntry: (entry: ClipboardEntry) => void,
		private clearItems: () => void,
	) {}

	public resetList(): void {
		this._generation++;
		this._offset = 0;
		this._loading = false;
		this._hasMore = true;
		this._totalCount = 0;
		this._loadedIds.clear();
		this._searchMode = false;
		this._searchQuery = null;
		this._searchScanOffset = 0;
		this.clearItems();
	}

	public shouldLoadMore(): boolean {
		return this._hasMore && !this._loading;
	}

	public isLoading(): boolean {
		return this._loading;
	}

	public trackEntry(entry: ClipboardEntry): boolean {
		if (this._loadedIds.has(entry.id)) return false;
		this._loadedIds.add(entry.id);
		return true;
	}

	public untrackEntry(id: number): void {
		this._loadedIds.delete(id);
	}

	public async loadInitialPage(): Promise<void> {
		const generation = this._generation;
		if (this._loading) return;

		this._loading = true;
		try {
			const tracker = this.ext.entryTracker;
			if (!tracker) return;

			this._totalCount = await tracker.countEntries();
			const page = await tracker.loadPage(0, CLIPBOARD_PAGE_SIZE);
			if (generation !== this._generation) return;

			for (const entry of page) {
				if (this.trackEntry(entry)) {
					this.addEntry(entry);
				}
			}

			this._offset = page.length;
			this._hasMore = this._offset < this._totalCount;
		} catch (error) {
			this.ext.logger.error(error);
		} finally {
			if (generation === this._generation) {
				this._loading = false;
			}
		}
	}

	public async loadNextPage(): Promise<void> {
		if (this._searchMode && this._searchQuery) {
			await this.loadNextSearchPage();
			return;
		}

		if (this._loading || !this._hasMore) return;

		const generation = this._generation;
		this._loading = true;
		try {
			const tracker = this.ext.entryTracker;
			if (!tracker) return;

			const page = await tracker.loadPage(this._offset, CLIPBOARD_PAGE_SIZE);
			if (generation !== this._generation) return;

			for (const entry of page) {
				if (this.trackEntry(entry)) {
					this.addEntry(entry);
				}
			}

			this._offset += page.length;
			this._hasMore = page.length > 0 && this._offset < this._totalCount;
		} catch (error) {
			this.ext.logger.error(error);
		} finally {
			if (generation === this._generation) {
				this._loading = false;
			}
		}
	}

	public async loadAllRemaining(): Promise<void> {
		while (true) {
			if (this._loading) {
				// eslint-disable-next-line no-await-in-loop
				await this.waitForLoading();
				continue;
			}

			if (!this._hasMore) {
				break;
			}

			// eslint-disable-next-line no-await-in-loop
			await this.loadNextPage();
		}
	}

	private waitForLoading(): Promise<void> {
		return new Promise((resolve) => {
			const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
				if (!this._loading) {
					resolve();
					return GLib.SOURCE_REMOVE;
				}
				return GLib.SOURCE_CONTINUE;
			});
			void id;
		});
	}

	public search(query: SearchQuery): void {
		if (!isSearchActive(query)) {
			this.resetList();
			this.loadInitialPage().catch((error) => this.ext.logger.error(error));
			return;
		}

		this._generation++;
		this.clearItems();
		this._loadedIds.clear();
		this._searchMode = true;
		this._searchQuery = query.withChange(SearchChange.Different);
		this._searchScanOffset = 0;
		this._offset = 0;
		this._hasMore = true;
		this._loading = false;

		this.ext.entryTracker
			?.countEntries()
			.then((count) => {
				this._totalCount = count;
				return this.loadNextSearchPage();
			})
			.catch((error) => this.ext.logger.error(error));
	}

	private async loadNextSearchPage(): Promise<void> {
		if (this._loading || !this._hasMore || !this._searchQuery) return;

		const generation = this._generation;
		const query = this._searchQuery;
		this._loading = true;

		try {
			await this.collectSearchMatches(generation, query, 0);
		} catch (error) {
			this.ext.logger.error(error);
		} finally {
			if (generation === this._generation) {
				this._loading = false;
			}
		}
	}

	private async collectSearchMatches(generation: number, query: SearchQuery, matchesAdded: number): Promise<number> {
		const tracker = this.ext.entryTracker;
		if (!tracker) return matchesAdded;

		while (matchesAdded < CLIPBOARD_PAGE_SIZE && this._searchScanOffset < this._totalCount) {
			// eslint-disable-next-line no-await-in-loop
			const batch = await tracker.loadPage(this._searchScanOffset, CLIPBOARD_PAGE_SIZE);
			if (generation !== this._generation) return matchesAdded;

			if (batch.length === 0) {
				this._hasMore = false;
				break;
			}

			this._searchScanOffset += batch.length;

			for (const entry of batch) {
				if (!entryMatchesSearch(query, entry)) continue;
				if (this.trackEntry(entry)) {
					this.addEntry(entry);
					matchesAdded++;
				}
				if (matchesAdded >= CLIPBOARD_PAGE_SIZE) break;
			}
		}

		if (this._searchScanOffset >= this._totalCount) {
			this._hasMore = false;
		}

		return matchesAdded;
	}
}
