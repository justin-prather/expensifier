<script lang="ts">
	type ReferenceItem = { id: string; name: string };

	let {
		id,
		label,
		items,
		value,
		placeholder = 'Search…',
		compact = false,
		error,
		onselect,
		oncreate
	}: {
		id: string;
		label: string;
		items: readonly ReferenceItem[];
		value: string | null;
		placeholder?: string;
		compact?: boolean;
		error?: string;
		onselect: (id: string | null) => void;
		oncreate: (name: string) => Promise<ReferenceItem>;
	} = $props();

	let query = $state('');
	let open = $state(false);
	let activeIndex = $state(-1);
	let creating = $state(false);
	let createError = $state<string | null>(null);

	const selected = $derived(items.find((item) => item.id === value) ?? null);
	const normalizedQuery = $derived(query.trim().toLocaleLowerCase());
	const matches = $derived(
		normalizedQuery === ''
			? items
			: items.filter((item) => item.name.toLocaleLowerCase().includes(normalizedQuery))
	);
	const canCreate = $derived(
		query.trim() !== '' && !items.some((item) => item.name.toLocaleLowerCase() === normalizedQuery)
	);
	const listboxId = $derived(`${id}-options`);

	$effect(() => {
		if (!open) query = selected?.name ?? '';
	});

	function choose(item: ReferenceItem) {
		onselect(item.id);
		query = item.name;
		open = false;
		activeIndex = -1;
		createError = null;
	}

	function onInput(event: Event) {
		query = (event.currentTarget as HTMLInputElement).value;
		onselect(null);
		open = true;
		activeIndex = -1;
		createError = null;
	}

	async function createItem() {
		const name = query.trim();
		if (!name || creating) return;
		creating = true;
		createError = null;
		try {
			choose(await oncreate(name));
		} catch (cause) {
			createError =
				cause instanceof Error ? cause.message : `Unable to create ${label.toLowerCase()}`;
		} finally {
			creating = false;
		}
	}

	function onKeyDown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			open = true;
			activeIndex = Math.min(activeIndex + 1, matches.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			activeIndex = matches.length > 0 ? Math.max(activeIndex - 1, 0) : -1;
		} else if (event.key === 'Enter' && open) {
			event.preventDefault();
			const match = matches[activeIndex] ?? (matches.length === 1 ? matches[0] : null);
			if (match) choose(match);
			else if (canCreate) void createItem();
		} else if (event.key === 'Escape') {
			open = false;
			query = selected?.name ?? '';
			activeIndex = -1;
		}
	}
</script>

<div class="relative">
	<label for={id} class={compact ? 'text-xs font-bold uppercase' : 'text-sm font-semibold'}>
		{label}
	</label>
	<input
		{id}
		type="text"
		role="combobox"
		autocomplete="off"
		aria-autocomplete="list"
		aria-expanded={open}
		aria-controls={listboxId}
		aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
		class={`mt-1 w-full border border-ink bg-white ${compact ? 'px-2 py-1.5 text-sm' : 'px-3 py-2'} font-normal`}
		value={query}
		{placeholder}
		oninput={onInput}
		onfocus={() => (open = true)}
		onblur={() => {
			open = false;
			query = selected?.name ?? '';
		}}
		onkeydown={onKeyDown}
	/>
	{#if open}
		<div
			id={listboxId}
			role="listbox"
			class="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto border border-ink bg-white text-sm font-normal normal-case shadow-[3px_3px_0_0_var(--color-ink)]"
		>
			{#each matches as item, index (item.id)}
				<button
					id={`${id}-option-${index}`}
					type="button"
					role="option"
					aria-selected={item.id === value}
					class={`block w-full px-3 py-2 text-left ${index === activeIndex ? 'bg-sand' : 'hover:bg-sand/60'}`}
					onmousedown={(event) => event.preventDefault()}
					onclick={() => choose(item)}>{item.name}</button
				>
			{/each}
			{#if matches.length === 0 && !canCreate}
				<p class="px-3 py-2 text-ink/50">No matches</p>
			{/if}
			{#if canCreate}
				<button
					type="button"
					class="block w-full border-t border-ink/20 px-3 py-2 text-left font-semibold text-forest hover:bg-emerald-50 disabled:opacity-50"
					disabled={creating}
					onmousedown={(event) => event.preventDefault()}
					onclick={createItem}
				>
					{creating ? 'Creating…' : `Create “${query.trim()}”`}
				</button>
			{/if}
		</div>
	{/if}
	{#if createError || error}
		<span class="mt-1 block font-mono text-xs text-rose-700">{createError ?? error}</span>
	{/if}
</div>
