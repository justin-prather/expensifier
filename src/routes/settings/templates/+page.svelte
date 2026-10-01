<script lang="ts">
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let filename = $state(form?.filename ?? data.filename);
	let destination = $state(form?.destination ?? data.destination);
	const preview = $derived(form?.preview ?? data.preview);

	const tokens = [
		'{date}',
		'{year}',
		'{month}',
		'{monthName}',
		'{vendor}',
		'{amount}',
		'{currency}',
		'{paymentAccount}',
		'{notes}',
		'{billable}',
		'{client}',
		'{extension}',
		'{expenseId}'
	];
</script>

<svelte:head>
	<title>File templates | Expensifier</title>
	<meta
		name="description"
		content="Configure the filename and destination templates used when expenses are approved."
	/>
</svelte:head>

<main class="mx-auto min-h-screen max-w-6xl px-5 py-6 sm:px-8 sm:py-10">
	<header
		class="flex flex-col gap-5 border-b-2 border-ink pb-7 sm:flex-row sm:items-end sm:justify-between"
	>
		<div>
			<a
				href="/settings"
				class="font-mono text-xs font-bold tracking-[0.18em] text-forest uppercase hover:text-coral"
			>
				← Settings
			</a>
			<h1 class="mt-3 text-4xl font-semibold tracking-[-0.045em] sm:text-6xl">File templates.</h1>
			<p class="mt-3 max-w-2xl text-ink/65">
				Approved receipts are renamed and filed using these patterns. The preview renders with
				sample values.
			</p>
		</div>
		<p class="font-mono text-xs font-bold tracking-[0.2em] text-forest uppercase">Admin settings</p>
	</header>

	{#if form?.message}
		<div class="mt-6 border-l-4 border-coral bg-white/55 px-4 py-3 text-sm font-semibold">
			{form.message}
		</div>
	{/if}

	<section class="grid gap-8 py-8 lg:grid-cols-[1.2fr_0.8fr]">
		<form method="POST" action="?/save" class="border-2 border-ink bg-white/45 p-6">
			<label class="block">
				<span class="text-xs font-bold tracking-[0.12em] uppercase">Filename template</span>
				<input
					name="filename"
					bind:value={filename}
					required
					class="mt-2 w-full border-2 border-ink bg-paper px-4 py-3 font-mono text-sm"
				/>
			</label>
			<label class="mt-5 block">
				<span class="text-xs font-bold tracking-[0.12em] uppercase">Destination template</span>
				<input
					name="destination"
					bind:value={destination}
					required
					class="mt-2 w-full border-2 border-ink bg-paper px-4 py-3 font-mono text-sm"
				/>
				<span class="mt-2 block text-xs leading-5 text-ink/60">
					Billable expenses always go to <code>processed/billable</code> first; this template
					controls non-billable filing. Date tokens use the receipt date, with
					<code>{'{month}'}</code>
					producing a two-digit month and <code>{'{monthName}'}</code> its English name.
				</span>
			</label>
			<button
				class="mt-6 bg-coral px-5 py-3.5 text-sm font-extrabold tracking-[0.1em] uppercase shadow-[4px_4px_0_#f5f1e8] hover:-translate-y-0.5"
				>Save templates</button
			>
		</form>

		<div class="space-y-6">
			<div class="border-2 border-ink bg-white/45 p-6">
				<h2 class="text-xl font-semibold">Preview</h2>
				<p class="mt-3 font-mono text-xs tracking-[0.14em] text-ink/50 uppercase">
					Sample values rendered live
				</p>
				<dl class="mt-4 space-y-3 font-mono text-xs">
					<div>
						<dt class="font-bold text-ink/55 uppercase">Destination</dt>
						<dd class="mt-1 bg-sand px-3 py-2 break-all">{preview.destination || '—'}</dd>
					</div>
					<div>
						<dt class="font-bold text-ink/55 uppercase">Filename</dt>
						<dd class="mt-1 bg-sand px-3 py-2 break-all">{preview.filename || '—'}</dd>
					</div>
				</dl>
			</div>
			<div class="border-2 border-dashed border-ink/40 p-6">
				<h2 class="text-xl font-semibold">Tokens</h2>
				<ul class="mt-3 flex flex-wrap gap-2">
					{#each tokens as token (token)}
						<li class="bg-sand px-2 py-1 font-mono text-xs font-bold">{token}</li>
					{/each}
				</ul>
			</div>
		</div>
	</section>
</main>
