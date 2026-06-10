import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { ItemType } from '../common/constants.js';
import { ClipboardHistory } from '../common/settings.js';
import { ClipboardEntry, Database, Metadata } from './database.js';

/**
 * In memory database
 */
export class MemoryDatabase implements Database {
	protected _entries: Map<string, ClipboardEntry> = new Map();
	protected _keys: Map<number, string> = new Map();
	protected _id: number = 0;
	protected _sortedEntries: ClipboardEntry[] | null = null;

	constructor() {}

	public async init(): Promise<void> {}

	public clear(history: ClipboardHistory): Promise<number[]> {
		let deleted: number[] = [];
		switch (history) {
			case ClipboardHistory.Clear:
				deleted = Array.from(this._keys.keys());
				this._entries.clear();
				this._keys.clear();
				break;
			case ClipboardHistory.KeepPinnedAndTagged:
				deleted = [];
				for (const [key, entry] of this._entries) {
					if (!(entry.pinned || entry.tag)) {
						this._entries.delete(key);
						this._keys.delete(entry.id);
						deleted.push(entry.id);
					}
				}
				break;
			case ClipboardHistory.KeepAll:
				break;
		}

		this._sortedEntries = null;
		return Promise.resolve(deleted);
	}

	public async close(): Promise<void> {
		await this.clear(ClipboardHistory.Clear);
	}

	public entries(): Promise<ClipboardEntry[]> {
		if (this._sortedEntries === null) {
			this._sortedEntries = Array.from(this._entries.values()).sort((a, b) => b.datetime.compare(a.datetime));
		}
		return Promise.resolve(this._sortedEntries);
	}

	public async entriesPage(offset: number, limit: number): Promise<ClipboardEntry[]> {
		const entries = await this.entries();
		return entries.slice(offset, offset + limit);
	}

	public countEntries(): Promise<number> {
		return Promise.resolve(this._entries.size);
	}

	public getEntryById(id: number): Promise<ClipboardEntry | null> {
		const key = this._keys.get(id);
		if (!key) return Promise.resolve(null);
		return Promise.resolve(this._entries.get(key) ?? null);
	}

	public hasUnprotectedEntriesOlderThan(olderThanMinutes: number): Promise<boolean> {
		if (olderThanMinutes <= 0) return Promise.resolve(false);

		const now = GLib.DateTime.new_now_utc();
		const olderThan = now.add_minutes(-olderThanMinutes)!;

		for (const entry of this._entries.values()) {
			if (entry.pinned || entry.tag) continue;
			if (entry.datetime.compare(olderThan) < 0) return Promise.resolve(true);
		}

		return Promise.resolve(false);
	}

	public selectConflict(entry: ClipboardEntry | { type: ItemType; content: string }): Promise<number | null> {
		const key = this.entryToKey(entry);
		return Promise.resolve(this._entries.get(key)?.id ?? null);
	}

	public insert(type: ItemType, content: string, metadata: Metadata | null = null): Promise<ClipboardEntry | null> {
		const key = this.entryToKey({ type, content });
		const entry = this._entries.get(key);
		if (entry) {
			return Promise.resolve(null);
		} else {
			const newEntry = new ClipboardEntry(
				this._id++,
				type,
				content,
				false,
				null,
				GLib.DateTime.new_now_utc(),
				metadata,
			);
			this._entries.set(key, newEntry);
			this._keys.set(newEntry.id, key);
			this._sortedEntries = null;
			return Promise.resolve(newEntry);
		}
	}

	public updateProperty(
		entry: ClipboardEntry,
		property: Exclude<keyof ClipboardEntry, keyof GObject.Object>,
	): Promise<number> {
		this._sortedEntries = null;
		if (property !== 'content') return Promise.resolve(-1);

		const key = this.entryToKey(entry);
		const existingEntry = this._entries.get(key);
		if (existingEntry) {
			return Promise.resolve(existingEntry.id);
		} else {
			const prevKey = this._keys.get(entry.id);
			if (prevKey) this._entries.delete(prevKey);

			this._entries.set(key, entry);
			this._keys.set(entry.id, key);
			return Promise.resolve(-1);
		}
	}

	public delete(entry: ClipboardEntry): Promise<boolean> {
		const key = this._keys.get(entry.id);
		this._keys.delete(entry.id);
		if (key) {
			this._entries.delete(key);
			this._sortedEntries = null;
			return Promise.resolve(true);
		}

		return Promise.resolve(false);
	}

	public async deleteOldest(offset: number, olderThanMinutes: number): Promise<number[]> {
		const entries = await this.entries();
		const unprotected = entries.filter((e) => !(e.pinned || e.tag));
		const deleted = unprotected.slice(offset).map((e) => e.id);

		if (olderThanMinutes > 0) {
			const now = GLib.DateTime.new_now_utc();
			const olderThan = now.add_minutes(-olderThanMinutes)!;
			const deletedIds = new Set(deleted);
			for (const entry of unprotected) {
				if (!deletedIds.has(entry.id) && entry.datetime.compare(olderThan) < 0) {
					deletedIds.add(entry.id);
					deleted.push(entry.id);
				}
			}
		}

		for (const id of deleted) {
			const key = this._keys.get(id);
			this._keys.delete(id);
			if (key) this._entries.delete(key);
		}

		if (deleted.length > 0) {
			this._sortedEntries = null;
		}

		return deleted;
	}

	protected entryToKey(entry: ClipboardEntry | { type: ItemType; content: string }) {
		return `${entry.type}:${entry.content}`;
	}
}
