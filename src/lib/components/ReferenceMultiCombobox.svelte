<script lang="ts">
	import ReferenceCombobox from './ReferenceCombobox.svelte';

	type ReferenceItem = { id: string; name: string };

	let {
		id,
		label,
		items,
		values,
		error,
		onchange,
		oncreate
	}: {
		id: string;
		label: string;
		items: readonly ReferenceItem[];
		values: readonly string[];
		error?: string;
		onchange: (ids: string[]) => void;
		oncreate: (name: string) => Promise<ReferenceItem>;
	} = $props();

	const selected = $derived(
		values
			.map((value) => items.find((item) => item.id === value))
			.filter((item): item is ReferenceItem => !!item)
	);
	const available = $derived(items.filter((item) => !values.includes(item.id)));

	function add(value: string | null) {
		if (value && !values.includes(value)) onchange([...values, value]);
	}

	function remove(value: string) {
		onchange(values.filter((clientId) => clientId !== value));
	}
</script>

<div>
	<p class="text-sm font-semibold">{label}</p>
	{#if selected.length > 0}
		<div class="mt-1 flex flex-wrap gap-1.5">
			{#each selected as item (item.id)}
				<span class="flex items-center gap-1 border border-ink/30 bg-sand/60 px-2 py-1 text-xs">
					{item.name}
					<button
						type="button"
						class="font-mono font-bold hover:text-rose-700"
						aria-label={`Remove ${item.name}`}
						onclick={() => remove(item.id)}>&times;</button
					>
				</span>
			{/each}
		</div>
	{/if}
	<div class={selected.length > 0 ? 'mt-2' : ''}>
		<ReferenceCombobox
			{id}
			label="Add client"
			items={available}
			value={null}
			placeholder="Search or create clients..."
			{error}
			onselect={add}
			{oncreate}
		/>
	</div>
</div>
