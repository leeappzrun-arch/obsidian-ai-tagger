import {
	App,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	requestUrl,
	Setting,
	TFile,
} from "obsidian";

type AiProvider = "ollama" | "openai-compatible";
type TagFormat = "keep" | "lower-kebab" | "uc-first" | "camel" | "pascal" | "snake";

interface TagSearchLinkCandidate {
	text: string;
	tag: string;
}

interface AiTaggerSettings {
	provider: AiProvider;
	endpointUrl: string;
	apiKey: string;
	model: string;
	autoGenerate: boolean;
	autoDebounceSeconds: number;
	tagSearchLinks: boolean;
	tagFormat: TagFormat;
	maxTags: number;
	generatedTagsProperty: string;
}

const DEFAULT_SETTINGS: AiTaggerSettings = {
	provider: "ollama",
	endpointUrl: "http://localhost:11434",
	apiKey: "",
	model: "",
	autoGenerate: false,
	autoDebounceSeconds: 8,
	tagSearchLinks: false,
	tagFormat: "lower-kebab",
	maxTags: 8,
	generatedTagsProperty: "aiGeneratedTags",
};

export default class AiTaggerPlugin extends Plugin {
	settings: AiTaggerSettings;
	private autoTimers = new Map<string, number>();
	private contentHashes = new Map<string, string>();
	private runningFiles = new Set<string>();
	private recentlyUpdated = new Map<string, number>();

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new AiTaggerSettingTab(this.app, this));

		this.addRibbonIcon("sparkles", "Generate AI tags for active note", async () => {
			await this.generateForActiveNote();
		});

		this.addCommand({
			id: "generate-tags-active-note",
			name: "Generate tags for active note",
			checkCallback: (checking) => {
				const file = this.getActiveMarkdownFile();
				if (!file) {
					return false;
				}
				if (!checking) {
					void this.generateTagsForFile(file);
				}
				return true;
			},
		});

		this.addCommand({
			id: "generate-tags-all-notes",
			name: "Generate tags for all notes in vault",
			callback: async () => {
				const files = this.app.vault.getMarkdownFiles();
				new Notice(`AI Tagger: generating tags for ${files.length} notes.`);
				for (const file of files) {
					await this.generateTagsForFile(file, true);
				}
				new Notice("AI Tagger: finished vault tag generation.");
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") {
					return;
				}
				menu.addItem((item) => {
					item
						.setTitle("Generate AI tags")
						.setIcon("sparkles")
						.onClick(() => {
							void this.generateTagsForFile(file);
						});
				});
			})
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (this.settings.autoGenerate && file instanceof TFile && file.extension === "md") {
					this.scheduleAutoGenerate(file);
				}
			})
		);
	}

	onunload() {
		for (const timer of this.autoTimers.values()) {
			window.clearTimeout(timer);
		}
		this.autoTimers.clear();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private getActiveMarkdownFile(): TFile | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view?.file ?? this.app.workspace.getActiveFile();
	}

	private async generateForActiveNote() {
		const file = this.getActiveMarkdownFile();
		if (!file || file.extension !== "md") {
			new Notice("AI Tagger: open a markdown note first.");
			return;
		}
		await this.generateTagsForFile(file);
	}

	private scheduleAutoGenerate(file: TFile) {
		const recentUpdate = this.recentlyUpdated.get(file.path) ?? 0;
		if (Date.now() - recentUpdate < 2000) {
			return;
		}

		const existingTimer = this.autoTimers.get(file.path);
		if (existingTimer) {
			window.clearTimeout(existingTimer);
		}

		const delayMs = Math.max(2, this.settings.autoDebounceSeconds) * 1000;
		const timer = window.setTimeout(async () => {
			this.autoTimers.delete(file.path);
			await this.generateTagsForFile(file, true);
		}, delayMs);
		this.autoTimers.set(file.path, timer);
	}

	async generateTagsForFile(file: TFile, quiet = false) {
		if (this.runningFiles.has(file.path)) {
			return;
		}
		if (!this.settings.endpointUrl.trim()) {
			new Notice("AI Tagger: add an AI URL in settings first.");
			return;
		}
		if (!this.settings.model.trim()) {
			new Notice("AI Tagger: add a model name in settings first.");
			return;
		}

		this.runningFiles.add(file.path);
		try {
			const note = await this.app.vault.cachedRead(file);
			const hash = await hashText(note);
			if (quiet && this.contentHashes.get(file.path) === hash) {
				return;
			}
			this.contentHashes.set(file.path, hash);

			if (!quiet) {
				new Notice(`AI Tagger: generating tags for ${file.basename}...`);
			}

			const existingTags = this.getExistingVaultTags(file);
			const generated = await this.requestTags(file, note, existingTags);
			if (!generated.length) {
				new Notice(`AI Tagger: no tags returned for ${file.basename}.`);
				return;
			}

			const finalGeneratedTags = this.prepareTags(generated, existingTags);
			this.recentlyUpdated.set(file.path, Date.now());
			await this.writeGeneratedTags(file, finalGeneratedTags);
			if (this.settings.tagSearchLinks) {
				const tagSearchLinks = await this.requestTagSearchLinks(file, note, [
					...existingTags,
					...finalGeneratedTags,
				]);
				await this.writeTagSearchLinks(file, tagSearchLinks, [...existingTags, ...finalGeneratedTags]);
			}
			const updatedNote = await this.app.vault.cachedRead(file);
			this.contentHashes.set(file.path, await hashText(updatedNote));
			this.recentlyUpdated.set(file.path, Date.now());

			if (!quiet) {
				new Notice(`AI Tagger: updated ${finalGeneratedTags.length} tags for ${file.basename}.`);
			}
		} catch (error) {
			console.error("AI Tagger failed", error);
			new Notice(`AI Tagger: ${error instanceof Error ? error.message : "tag generation failed"}`);
		} finally {
			this.runningFiles.delete(file.path);
		}
	}

	private getExistingVaultTags(file: TFile): string[] {
		const tags = new Set<string>();

		for (const markdownFile of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(markdownFile);
			for (const tagCache of cache?.tags ?? []) {
				const cleaned = cleanTag(tagCache.tag);
				if (cleaned) {
					tags.add(cleaned);
				}
			}

			for (const tag of asTagArray(cache?.frontmatter?.tags)) {
				tags.add(tag);
			}
		}

		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatterTags = asTagArray(cache?.frontmatter?.tags);
		for (const tag of frontmatterTags) {
			tags.add(tag);
		}

		return [...tags].sort((a, b) => a.localeCompare(b));
	}

	private async requestTags(file: TFile, note: string, existingTags: string[]): Promise<string[]> {
		const prompt = this.buildPrompt(file, note, existingTags);
		const provider = this.settings.provider;

		if (provider === "ollama") {
			const response = await requestUrl({
				url: makeOllamaGenerateUrl(this.settings.endpointUrl),
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(this.settings.apiKey ? { Authorization: `Bearer ${this.settings.apiKey}` } : {}),
				},
				body: JSON.stringify({
					model: this.settings.model,
					prompt,
					stream: false,
					format: "json",
					options: {
						temperature: 0.1,
					},
				}),
			});
			const content = response.json?.response ?? response.text;
			return extractTags(content);
		}

		const response = await requestUrl({
			url: makeChatCompletionsUrl(this.settings.endpointUrl),
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(this.settings.apiKey ? { Authorization: `Bearer ${this.settings.apiKey}` } : {}),
			},
			body: JSON.stringify({
				model: this.settings.model,
				temperature: 0.1,
				messages: [
					{
						role: "system",
						content:
							"You generate concise Obsidian tags. Return only valid JSON with a tags array.",
					},
					{
						role: "user",
						content: prompt,
					},
				],
			}),
		});

		const content = response.json?.choices?.[0]?.message?.content ?? response.text;
		return extractTags(content);
	}

	private async requestTagSearchLinks(
		file: TFile,
		note: string,
		availableTags: string[]
	): Promise<TagSearchLinkCandidate[]> {
		const tags = uniqueTags(availableTags).slice(0, 300);
		if (!tags.length) {
			return [];
		}

		const prompt = this.buildTagSearchLinksPrompt(file, note, tags);
		const provider = this.settings.provider;

		if (provider === "ollama") {
			const response = await requestUrl({
				url: makeOllamaGenerateUrl(this.settings.endpointUrl),
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(this.settings.apiKey ? { Authorization: `Bearer ${this.settings.apiKey}` } : {}),
				},
				body: JSON.stringify({
					model: this.settings.model,
					prompt,
					stream: false,
					format: "json",
					options: {
						temperature: 0.1,
					},
				}),
			});
			const content = response.json?.response ?? response.text;
			return extractTagSearchLinks(content, tags);
		}

		const response = await requestUrl({
			url: makeChatCompletionsUrl(this.settings.endpointUrl),
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(this.settings.apiKey ? { Authorization: `Bearer ${this.settings.apiKey}` } : {}),
			},
			body: JSON.stringify({
				model: this.settings.model,
				temperature: 0.1,
				messages: [
					{
						role: "system",
						content:
							"You add conservative Obsidian tag-search links. Return only valid JSON with a links array.",
					},
					{
						role: "user",
						content: prompt,
					},
				],
			}),
		});

		const content = response.json?.choices?.[0]?.message?.content ?? response.text;
		return extractTagSearchLinks(content, tags);
	}

	private buildPrompt(file: TFile, note: string, existingTags: string[]): string {
		const clippedNote = stripFrontmatter(note).slice(0, 12000);
		const existingTagText = existingTags.slice(0, 250).join(", ");

		return [
			`Note title: ${file.basename}`,
			"",
			"Task: suggest the best Obsidian tags for this note.",
			`Return at most ${this.settings.maxTags} tags.`,
			"Prefer an existing tag when it matches the concept, even if its casing or punctuation differs.",
			"Use broad, reusable tags rather than one-off labels.",
			"Do not include the leading #.",
			'Return JSON only, exactly like: {"tags":["example","another-tag"]}',
			"",
			"Existing vault tags:",
			existingTagText || "(none)",
			"",
			"Note content:",
			clippedNote,
		].join("\n");
	}

	private buildTagSearchLinksPrompt(file: TFile, note: string, availableTags: string[]): string {
		const clippedNote = stripFrontmatter(note).slice(0, 12000);
		const tagText = availableTags.join(", ");

		return [
			`Note title: ${file.basename}`,
			"",
			"Task: find words or short phrases in the note that should link to an Obsidian tag search.",
			"Each link must use one of the available tags exactly as written.",
			'The "text" value must be exact visible text copied from the note body.',
			"Choose text that is semantically related to the tag, not just text that shares a few letters.",
			"Do not choose text from YAML frontmatter, existing markdown links, wikilinks, code blocks, inline code, or literal #tags.",
			"If a selected word or phrase appears multiple times in normal note text, include it once; the plugin will link every safe instance.",
			"Avoid linking headings unless there is no better body text.",
			'Return JSON only, exactly like: {"links":[{"text":"home lab","tag":"homelab"}]}',
			"",
			"Available tags:",
			tagText,
			"",
			"Note content:",
			clippedNote,
		].join("\n");
	}

	private prepareTags(rawTags: string[], existingTags: string[]): string[] {
		const existingByCanonical = new Map<string, string>();
		for (const existing of existingTags) {
			existingByCanonical.set(canonicalTag(existing), existing);
		}

		const tags: string[] = [];
		const seen = new Set<string>();

		for (const rawTag of rawTags) {
			const cleaned = cleanTag(rawTag);
			if (!cleaned) {
				continue;
			}

			const existing = existingByCanonical.get(canonicalTag(cleaned));
			const formatted = existing ?? formatTag(cleaned, this.settings.tagFormat);
			const finalTag = cleanTag(formatted);
			const key = canonicalTag(finalTag);

			if (finalTag && !seen.has(key)) {
				tags.push(finalTag);
				seen.add(key);
			}
			if (tags.length >= this.settings.maxTags) {
				break;
			}
		}

		return tags;
	}

	private async writeGeneratedTags(file: TFile, generatedTags: string[]) {
		const property = this.settings.generatedTagsProperty || DEFAULT_SETTINGS.generatedTagsProperty;

		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const currentTags = asTagArray(frontmatter.tags);
			const previousGenerated = asTagArray(frontmatter[property]);
			const previousGeneratedKeys = new Set(previousGenerated.map(canonicalTag));
			const generatedKeys = new Set(generatedTags.map(canonicalTag));
			const merged: string[] = [];
			const seen = new Set<string>();

			for (const tag of currentTags) {
				const key = canonicalTag(tag);
				if (previousGeneratedKeys.has(key)) {
					continue;
				}
				if (!seen.has(key)) {
					merged.push(tag);
					seen.add(key);
				}
			}

			for (const tag of generatedTags) {
				const key = canonicalTag(tag);
				if (!generatedKeys.has(key) || seen.has(key)) {
					continue;
				}
				merged.push(tag);
				seen.add(key);
			}

			frontmatter.tags = merged;
			frontmatter[property] = generatedTags;
		});
	}

	private async writeTagSearchLinks(
		file: TFile,
		candidates: TagSearchLinkCandidate[],
		availableTags: string[]
	) {
		const tagByCanonical = new Map<string, string>();
		for (const tag of availableTags) {
			const cleaned = cleanTag(tag);
			if (cleaned) {
				tagByCanonical.set(canonicalTag(cleaned), cleaned);
			}
		}

		const validCandidates = candidates
			.map((candidate) => ({
				text: candidate.text.trim(),
				tag: tagByCanonical.get(canonicalTag(candidate.tag)),
			}))
			.filter((candidate): candidate is { text: string; tag: string } =>
				Boolean(candidate.text && candidate.tag)
			);

		if (!validCandidates.length) {
			return;
		}

		const current = await this.app.vault.read(file);
		const updated = applyTagSearchLinks(current, validCandidates);
		if (updated !== current) {
			await this.app.vault.modify(file, updated);
		}
	}
}

class AiTaggerSettingTab extends PluginSettingTab {
	plugin: AiTaggerPlugin;

	constructor(app: App, plugin: AiTaggerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "AI Tagger" });
		containerEl.createEl("p", {
			cls: "ai-tagger-setting-muted",
			text:
				"Configure an AI endpoint for tag suggestions. Existing vault tags are sent as context so the model can reuse them where possible.",
		});

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Use Ollama's native generate API or an OpenAI-compatible chat completions endpoint.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("ollama", "Ollama")
					.addOption("openai-compatible", "OpenAI-compatible")
					.setValue(this.plugin.settings.provider)
					.onChange(async (value: AiProvider) => {
						this.plugin.settings.provider = value;
						if (value === "ollama" && !this.plugin.settings.endpointUrl) {
							this.plugin.settings.endpointUrl = "http://localhost:11434";
						}
						if (value === "openai-compatible" && !this.plugin.settings.endpointUrl) {
							this.plugin.settings.endpointUrl = "https://api.openai.com/v1";
						}
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("AI URL")
			.setDesc("Base URL or full endpoint URL. Examples: http://localhost:11434 or https://api.openai.com/v1.")
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:11434")
					.setValue(this.plugin.settings.endpointUrl)
					.onChange(async (value) => {
						this.plugin.settings.endpointUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Optional for local Ollama. Sent as a Bearer token when provided.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Model name to send to the configured endpoint.")
			.addText((text) =>
				text
					.setPlaceholder(this.plugin.settings.provider === "ollama" ? "llama3.1" : "gpt-4o-mini")
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Automatically generate tags")
			.setDesc("Regenerate generated tags after markdown note content changes.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoGenerate).onChange(async (value) => {
					this.plugin.settings.autoGenerate = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Auto-generate delay")
			.setDesc("Seconds to wait after the last file change before calling the AI.")
			.addText((text) =>
				text
					.setPlaceholder("8")
					.setValue(String(this.plugin.settings.autoDebounceSeconds))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (Number.isFinite(parsed)) {
							this.plugin.settings.autoDebounceSeconds = Math.max(2, Math.round(parsed));
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Tag search links (experimental)")
			.setDesc("Experimentally link related words in the note to Obsidian tag searches when tags are generated.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.tagSearchLinks).onChange(async (value) => {
					this.plugin.settings.tagSearchLinks = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Tag format")
			.setDesc("Applied to new tags. Existing matching tags keep their current spelling.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("keep", "Keep AI output")
					.addOption("lower-kebab", "lower-kebab")
					.addOption("uc-first", "UC first")
					.addOption("camel", "camelCase")
					.addOption("pascal", "PascalCase")
					.addOption("snake", "snake_case")
					.setValue(this.plugin.settings.tagFormat)
					.onChange(async (value: TagFormat) => {
						this.plugin.settings.tagFormat = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Maximum tags")
			.setDesc("Upper limit for generated tags per note.")
			.addText((text) =>
				text
					.setPlaceholder("8")
					.setValue(String(this.plugin.settings.maxTags))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (Number.isFinite(parsed)) {
							this.plugin.settings.maxTags = Math.max(1, Math.min(30, Math.round(parsed)));
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Generated tags property")
			.setDesc("Frontmatter property used to remember tags managed by this plugin.")
			.addText((text) =>
				text
					.setPlaceholder("aiGeneratedTags")
					.setValue(this.plugin.settings.generatedTagsProperty)
					.onChange(async (value) => {
						this.plugin.settings.generatedTagsProperty =
							value.trim() || DEFAULT_SETTINGS.generatedTagsProperty;
						await this.plugin.saveSettings();
					})
			);
	}
}

function makeOllamaGenerateUrl(endpointUrl: string): string {
	const trimmed = trimTrailingSlash(endpointUrl.trim());
	if (trimmed.endsWith("/api/generate")) {
		return trimmed;
	}
	return `${trimmed}/api/generate`;
}

function makeChatCompletionsUrl(endpointUrl: string): string {
	const trimmed = trimTrailingSlash(endpointUrl.trim());
	if (trimmed.endsWith("/chat/completions")) {
		return trimmed;
	}
	return `${trimmed}/chat/completions`;
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function asTagArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((tag) => cleanTag(String(tag))).filter(Boolean);
	}
	if (typeof value === "string") {
		return value
			.split(/[,\s]+/)
			.map(cleanTag)
			.filter(Boolean);
	}
	return [];
}

function extractTags(content: unknown): string[] {
	if (Array.isArray(content)) {
		return content.map(String);
	}
	if (typeof content !== "string") {
		return [];
	}

	const jsonText = extractJsonText(content);
	try {
		const parsed = JSON.parse(jsonText);
		if (Array.isArray(parsed)) {
			return parsed.map(String);
		}
		if (Array.isArray(parsed.tags)) {
			return parsed.tags.map(String);
		}
	} catch (error) {
		console.warn("AI Tagger could not parse JSON response", error, content);
	}

	return content
		.split(/[,\n]+/)
		.map((tag) => tag.replace(/^[-*]\s*/, ""))
		.map(cleanTag)
		.filter(Boolean);
}

function extractTagSearchLinks(content: unknown, availableTags: string[]): TagSearchLinkCandidate[] {
	const tagByCanonical = new Map<string, string>();
	for (const tag of availableTags) {
		const cleaned = cleanTag(tag);
		if (cleaned) {
			tagByCanonical.set(canonicalTag(cleaned), cleaned);
		}
	}

	const parsed = parseJsonLike(content);
	const rawLinks = Array.isArray(parsed)
		? parsed
		: Array.isArray(parsed?.links)
			? parsed.links
			: [];
	const links: TagSearchLinkCandidate[] = [];
	const seen = new Set<string>();

	for (const rawLink of rawLinks) {
		if (!rawLink || typeof rawLink !== "object") {
			continue;
		}

		const text = typeof rawLink.text === "string" ? rawLink.text.trim() : "";
		const requestedTag = typeof rawLink.tag === "string" ? rawLink.tag : "";
		const tag = tagByCanonical.get(canonicalTag(requestedTag));
		const key = `${text.toLowerCase()}\u0000${canonicalTag(tag ?? "")}`;

		if (text && tag && !seen.has(key)) {
			links.push({ text, tag });
			seen.add(key);
		}
		if (links.length >= 20) {
			break;
		}
	}

	return links;
}

function parseJsonLike(content: unknown): any {
	if (typeof content !== "string") {
		return content;
	}

	try {
		return JSON.parse(extractJsonText(content));
	} catch (error) {
		console.warn("AI Tagger could not parse tag-search link JSON response", error, content);
		return null;
	}
}

function extractJsonText(content: string): string {
	const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced) {
		return fenced[1].trim();
	}

	const objectStart = content.indexOf("{");
	const objectEnd = content.lastIndexOf("}");
	if (objectStart !== -1 && objectEnd > objectStart) {
		return content.slice(objectStart, objectEnd + 1);
	}

	const arrayStart = content.indexOf("[");
	const arrayEnd = content.lastIndexOf("]");
	if (arrayStart !== -1 && arrayEnd > arrayStart) {
		return content.slice(arrayStart, arrayEnd + 1);
	}

	return content.trim();
}

function stripFrontmatter(note: string): string {
	if (!note.startsWith("---")) {
		return note;
	}
	const end = note.indexOf("\n---", 3);
	if (end === -1) {
		return note;
	}
	return note.slice(end + 4).trimStart();
}

function applyTagSearchLinks(note: string, candidates: TagSearchLinkCandidate[]): string {
	const { prefix, body } = splitFrontmatter(note);
	let linkedBody = body;
	const usedCandidates = new Set<string>();

	for (const candidate of candidates) {
		const candidateKey = `${candidate.text.toLowerCase()}\u0000${canonicalTag(candidate.tag)}`;
		if (usedCandidates.has(candidateKey)) {
			continue;
		}

		const result = linkAllPlainTextMatches(linkedBody, candidate.text, candidate.tag);
		if (result.changed) {
			linkedBody = result.text;
			usedCandidates.add(candidateKey);
		}
	}

	return prefix + linkedBody;
}

function splitFrontmatter(note: string): { prefix: string; body: string } {
	if (!note.startsWith("---")) {
		return { prefix: "", body: note };
	}

	const end = note.indexOf("\n---", 3);
	if (end === -1) {
		return { prefix: "", body: note };
	}

	let bodyStart = end + 4;
	if (note.slice(bodyStart, bodyStart + 2) === "\r\n") {
		bodyStart += 2;
	} else if (note.charAt(bodyStart) === "\n") {
		bodyStart += 1;
	}

	return {
		prefix: note.slice(0, bodyStart),
		body: note.slice(bodyStart),
	};
}

function linkAllPlainTextMatches(
	body: string,
	phrase: string,
	tag: string
): { text: string; changed: boolean } {
	const normalizedPhrase = phrase.replace(/\s+/g, " ").trim();
	if (!normalizedPhrase) {
		return { text: body, changed: false };
	}

	const protectedRanges = getProtectedMarkdownRanges(body);
	const pattern = new RegExp(escapeRegExp(normalizedPhrase).replace(/\s+/g, "\\s+"), "i");
	let searchFrom = 0;
	let linkedBody = body;
	let offset = 0;
	let changed = false;

	while (searchFrom < body.length) {
		const match = pattern.exec(body.slice(searchFrom));
		if (!match || match.index === undefined) {
			break;
		}

		const start = searchFrom + match.index;
		const end = start + match[0].length;
		if (isPlainTextLinkTarget(body, start, end, protectedRanges)) {
			const visibleText = escapeMarkdownLinkText(body.slice(start, end));
			const linked = `[${visibleText}](obsidian://search?query=tag:${encodeURIComponent(tag)})`;
			const linkedStart = start + offset;
			const linkedEnd = end + offset;
			linkedBody = linkedBody.slice(0, linkedStart) + linked + linkedBody.slice(linkedEnd);
			offset += linked.length - (end - start);
			changed = true;
		}

		searchFrom = end || searchFrom + 1;
	}

	return { text: linkedBody, changed };
}

function getProtectedMarkdownRanges(markdown: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const patterns = [
		/```[\s\S]*?(?:```|$)/g,
		/~~~[\s\S]*?(?:~~~|$)/g,
		/`[^`\n]+`/g,
		/!?\[[^\]\n]*\]\([^)\n]*\)/g,
		/\[\[[\s\S]*?\]\]/g,
		/https?:\/\/[^\s)]+/g,
		/(^|\s)#[A-Za-z0-9/_-]+/g,
	];

	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(markdown)) !== null) {
			const start = match[0].startsWith(" ") || match[0].startsWith("\n")
				? match.index + 1
				: match.index;
			ranges.push([start, match.index + match[0].length]);
		}
	}

	return mergeRanges(ranges);
}

function isPlainTextLinkTarget(
	markdown: string,
	start: number,
	end: number,
	protectedRanges: Array<[number, number]>
): boolean {
	if (protectedRanges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart)) {
		return false;
	}

	const previous = start > 0 ? markdown.charAt(start - 1) : "";
	const next = end < markdown.length ? markdown.charAt(end) : "";
	if (previous === "#" || /[A-Za-z0-9_-]/.test(previous) || /[A-Za-z0-9_-]/.test(next)) {
		return false;
	}

	return true;
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
	return ranges
		.sort((a, b) => a[0] - b[0])
		.reduce<Array<[number, number]>>((merged, range) => {
			const previous = merged[merged.length - 1];
			if (!previous || range[0] > previous[1]) {
				merged.push([...range]);
			} else {
				previous[1] = Math.max(previous[1], range[1]);
			}
			return merged;
		}, []);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeMarkdownLinkText(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
}

function cleanTag(tag: string): string {
	return tag
		.trim()
		.replace(/^#+/, "")
		.replace(/\\/g, "/")
		.replace(/\s+/g, "-")
		.replace(/[^A-Za-z0-9/_-]/g, "")
		.replace(/\/{2,}/g, "/")
		.replace(/^\/+|\/+$/g, "");
}

function canonicalTag(tag: string): string {
	return cleanTag(tag).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function uniqueTags(tags: string[]): string[] {
	const unique: string[] = [];
	const seen = new Set<string>();

	for (const tag of tags) {
		const cleaned = cleanTag(tag);
		const key = canonicalTag(cleaned);
		if (cleaned && !seen.has(key)) {
			unique.push(cleaned);
			seen.add(key);
		}
	}

	return unique;
}

function formatTag(tag: string, format: TagFormat): string {
	const parts = tag.split("/").map((part) => formatTagPart(part, format)).filter(Boolean);
	return parts.join("/");
}

function formatTagPart(tag: string, format: TagFormat): string {
	const words = tag
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.map((word) => word.trim())
		.filter(Boolean);

	if (!words.length) {
		return "";
	}

	switch (format) {
		case "keep":
			return cleanTag(tag);
		case "uc-first":
			return words.map(capitalize).join("-");
		case "camel":
			return words[0].toLowerCase() + words.slice(1).map(capitalize).join("");
		case "pascal":
			return words.map(capitalize).join("");
		case "snake":
			return words.map((word) => word.toLowerCase()).join("_");
		case "lower-kebab":
		default:
			return words.map((word) => word.toLowerCase()).join("-");
	}
}

function capitalize(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

async function hashText(value: string): Promise<string> {
	const data = new TextEncoder().encode(stripFrontmatter(value));
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
