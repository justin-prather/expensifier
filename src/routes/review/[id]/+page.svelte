<script lang="ts">
	import { deserialize, enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import DocumentViewer from '$lib/components/DocumentViewer.svelte';
	import { parseAmountToMinor } from '$lib/money';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	import type { ActionData, PageData } from './$types';

	type LineItemRow = {
		description: string;
		quantity: string;
		unitPrice: string;
		netAmount: string;
		taxAmount: string;
		grossAmount: string;
		categoryId: string;
	};

	type TaxRow = { label: string; amount: string; ratePercent: string };

	let vendor = $state(data.expense.vendor ?? '');
	let transactionDate = $state(data.expense.transactionDate ?? '');
	let total = $state(
		data.expense.totalMinor !== null && data.expense.totalMinor !== undefined
			? (data.expense.totalMinor / 100).toFixed(2)
			: ''
	);
	let currency = $state(data.expense.currency ?? 'CAD');
	let notes = $state(data.expense.notes ?? '');
	let billable = $state(data.expense.billable);
	let clientId = $state<string | null>(data.expense.clientId);
	let paymentAccountId = $state<string | null>(data.expense.paymentAccountId);
	let lineItems = $state<LineItemRow[]>(
		data.lineItems.length > 0 ? data.lineItems.map((item) => ({ ...item })) : [emptyLineItem()]
	);
	let taxComponents = $state<TaxRow[]>(data.taxComponents.map((item) => ({ ...item })));

	let fieldErrors = $state<Record<string, string>>({});
	let notice = $state<string | null>(null);
	let rejectReason = $state('');
	let preview = $state({ filename: data.preview.filename, destination: data.preview.destination });
	let refreshingPreview = $state(false);

	function emptyLineItem(): LineItemRow {
		return {
			description: '',
			quantity: '',
			unitPrice: '',
			netAmount: '',
			taxAmount: '',
			grossAmount: '',
			categoryId: ''
		};
	}

	const payload = $derived(
		JSON.stringify({
			vendor,
			transactionDate,
			total,
			currency,
			notes,
			billable,
			clientId,
			paymentAccountId,
			lineItems,
			taxComponents
		})
	);

	function rowEffectiveGross(row: LineItemRow): number | null {
		const gross = row.grossAmount.trim() === '' ? null : parseAmountToMinor(row.grossAmount);
		if (gross !== null) return gross;
		const net = row.netAmount.trim() === '' ? null : parseAmountToMinor(row.netAmount);
		const tax = row.taxAmount.trim() === '' ? null : parseAmountToMinor(row.taxAmount);
		if (net === null && tax === null) return null;
		return (net ?? 0) + (tax ?? 0);
	}

	const lineTotal = $derived(
		lineItems.reduce((sum, row) => sum + (rowEffectiveGross(row) ?? 0), 0)
	);
	const totalMinor = $derived(total.trim() === '' ? null : parseAmountToMinor(total));
	const balanced = $derived(
		totalMinor !== null && lineTotal === totalMinor && lineItems.length > 0
	);

	function addLineItem() {
		lineItems = [...lineItems, emptyLineItem()];
	}

	function removeLineItem(index: number) {
		lineItems = lineItems.filter((_, i) => i !== index);
		if (lineItems.length === 0) lineItems = [emptyLineItem()];
	}

	function addTaxComponent() {
		taxComponents = [...taxComponents, { label: 'GST', amount: '', ratePercent: '' }];
	}

	function removeTaxComponent(index: number) {
		taxComponents = taxComponents.filter((_, i) => i !== index);
	}

	type OcrField = { value: string | null; confidence: number | null; source: string };
	type OcrLineItem = {
		description: OcrField;
		quantity: OcrField;
		unitPrice: OcrField;
		netAmount: OcrField;
		taxAmount: OcrField;
		grossAmount: OcrField;
	};

	function applyOcrSuggestion() {
		const ocr = data.normalizedOcr as {
			merchantName?: OcrField;
			transactionDate?: OcrField;
			totalAmount?: OcrField;
			currencyCode?: OcrField;
			lineItems?: OcrLineItem[];
		} | null;
		if (!ocr) return;
		if (ocr.merchantName?.value) vendor = ocr.merchantName.value;
		if (ocr.transactionDate?.value) transactionDate = ocr.transactionDate.value.slice(0, 10);
		if (ocr.totalAmount?.value) total = Number(ocr.totalAmount.value).toFixed(2);
		const ocrCurrency = ocr.currencyCode?.value?.toUpperCase();
		if (ocrCurrency === 'CAD' || ocrCurrency === 'USD' || ocrCurrency === 'EUR')
			currency = ocrCurrency;
		if (ocr.lineItems?.length) {
			lineItems = ocr.lineItems.map((item) => ({
				description: item.description?.value ?? '',
				quantity: item.quantity?.value ?? '',
				unitPrice: item.unitPrice?.value ? Number(item.unitPrice.value).toFixed(2) : '',
				netAmount: item.netAmount?.value ? Number(item.netAmount.value).toFixed(2) : '',
				taxAmount: item.taxAmount?.value ? Number(item.taxAmount.value).toFixed(2) : '',
				grossAmount: item.grossAmount?.value ? Number(item.grossAmount.value).toFixed(2) : '',
				categoryId: ''
			}));
		}
		notice = 'OCR values applied. Review every field before approving.';
	}

	async function refreshPreview() {
		refreshingPreview = true;
		try {
			const body = new FormData();
			body.set('payload', payload);
			const response = await fetch(
				`?/preview-path&extension=${encodeURIComponent(data.document.extension)}`,
				{
					method: 'POST',
					body
				}
			);
			const result = deserialize(await response.text());
			if (result.type === 'success' && result.data) {
				const values = result.data as { filename: string; destination: string };
				preview = { filename: values.filename, destination: values.destination };
				fieldErrors = {};
			} else if (result.type === 'failure' && result.data?.fieldErrors) {
				fieldErrors = result.data.fieldErrors as Record<string, string>;
			}
		} finally {
			refreshingPreview = false;
		}
	}

	function onKeyDown(event: KeyboardEvent) {
		const target = event.target as HTMLElement | null;
		if (
			event.metaKey ||
			event.ctrlKey ||
			event.altKey ||
			(target &&
				(target.tagName === 'INPUT' ||
					target.tagName === 'TEXTAREA' ||
					target.tagName === 'SELECT' ||
					target.isContentEditable))
		) {
			return;
		}
		const key = event.key.toLowerCase();
		if (key === 's') {
			event.preventDefault();
			document.getElementById('save-button')?.click();
		} else if (key === 'a') {
			event.preventDefault();
			document.getElementById('approve-button')?.click();
		} else if (key === 'r') {
			event.preventDefault();
			document.getElementById('retry-ocr-button')?.click();
		} else if (key === 'x') {
			event.preventDefault();
			document.getElementById('reject-reason')?.focus();
		} else if (key === 'j' && data.nextId) {
			window.location.assign(`/review/${data.nextId}`);
		} else if (key === 'k' && data.previousId) {
			window.location.assign(`/review/${data.previousId}`);
		}
	}

	const statusBadge = {
		processing: 'bg-sky-100 text-sky-800',
		needs_review: 'bg-emerald-100 text-emerald-800',
		approved: 'bg-forest text-white',
		rejected: 'bg-rose-100 text-rose-800'
	} as const;

	function errorText(key: string): string | undefined {
		return fieldErrors[key];
	}
</script>

<svelte:head>
	<title>Review {data.document.originalFilename} | Expensifier</title>
</svelte:head>

<svelte:window onkeydown={onKeyDown} />

<main class="mx-auto min-h-screen max-w-[110rem] px-4 py-6 sm:px-8">
	<header
		class="flex flex-col gap-3 border-b-2 border-ink pb-5 lg:flex-row lg:items-end lg:justify-between"
	>
		<div class="min-w-0">
			<a
				href="/"
				class="font-mono text-xs font-bold tracking-[0.18em] text-forest uppercase hover:underline"
				>← Back to queue</a
			>
			<h1 class="mt-2 truncate text-2xl font-semibold tracking-tight sm:text-3xl">
				{data.document.originalFilename}
			</h1>
			<p class="mt-1 font-mono text-xs text-ink/50">
				{data.document.currentRelativePath} · {data.document.byteSize} bytes · RUNS {data.ocrRunCount}
			</p>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<span
				class={`px-2.5 py-1 font-mono text-xs font-bold uppercase ${statusBadge[data.expense.status]}`}
			>
				{data.expense.status.replace('_', ' ')}
			</span>
			{#if data.previousId}
				<a
					href="/review/{data.previousId}"
					data-sveltekit-reload
					class="border border-ink px-3 py-1.5 font-mono text-xs font-bold uppercase hover:bg-ink hover:text-paper"
					title="Previous review item (K)">Prev (K)</a
				>
			{/if}
			{#if data.nextId}
				<a
					href="/review/{data.nextId}"
					data-sveltekit-reload
					class="border border-ink px-3 py-1.5 font-mono text-xs font-bold uppercase hover:bg-ink hover:text-paper"
					title="Next review item (J)">Next (J)</a
				>
			{/if}
		</div>
	</header>

	{#if data.document.duplicateOfFilename}
		<p
			class="mt-4 border border-amber-700 bg-amber-100 px-4 py-3 text-sm font-semibold text-amber-900"
		>
			Duplicate warning: content matches “{data.document.duplicateOfFilename}”. Confirm before
			approving.
		</p>
	{/if}
	{#if data.expense.status === 'rejected'}
		<p
			class="mt-4 border border-rose-600 bg-rose-100 px-4 py-3 text-sm font-semibold text-rose-900"
		>
			Rejected{data.expense.rejectionReason ? `: ${data.expense.rejectionReason}` : ''}.
		</p>
	{/if}
	{#if data.expense.status === 'approved'}
		<p
			class="mt-4 border border-forest bg-emerald-100 px-4 py-3 text-sm font-semibold text-emerald-900"
		>
			Approved and filed under {data.document.currentRelativePath}.
		</p>
	{/if}
	{#if notice || form?.message}
		<p class="mt-4 border border-ink bg-white/60 px-4 py-3 font-mono text-xs">
			{notice ?? form?.message}
		</p>
	{/if}

	<section class="grid gap-6 py-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
		<div class="xl:sticky xl:top-6 xl:self-start">
			<DocumentViewer
				documentId={data.document.id}
				mimeType={data.document.mimeType}
				originalFilename={data.document.originalFilename}
			/>
		</div>

		<div class="flex flex-col gap-6">
			<div class="border-2 border-ink bg-white/40 p-5">
				<div class="flex items-center justify-between">
					<h2 class="text-lg font-semibold">Expense details</h2>
					<button
						type="button"
						class="border border-ink px-2 py-1 font-mono text-[11px] font-bold uppercase hover:bg-ink hover:text-paper"
						onclick={applyOcrSuggestion}
						disabled={!data.normalizedOcr}>Apply OCR</button
					>
				</div>
				<div class="mt-4 grid gap-4 sm:grid-cols-2">
					<label class="text-sm font-semibold">
						Vendor
						<input
							class="mt-1 w-full border border-ink bg-paper px-3 py-2 font-normal"
							bind:value={vendor}
							name="vendor"
						/>
						{#if errorText('vendor')}<span class="mt-1 block font-mono text-xs text-rose-700"
								>{errorText('vendor')}</span
							>{/if}
					</label>
					<label class="text-sm font-semibold">
						Transaction date
						<input
							type="date"
							class="mt-1 w-full border border-ink bg-paper px-3 py-2 font-normal"
							bind:value={transactionDate}
						/>
						{#if errorText('transactionDate')}<span
								class="mt-1 block font-mono text-xs text-rose-700"
								>{errorText('transactionDate')}</span
							>{/if}
					</label>
					<label class="text-sm font-semibold">
						Total amount
						<input
							inputmode="decimal"
							class="mt-1 w-full border border-ink bg-paper px-3 py-2 font-normal"
							bind:value={total}
						/>
						{#if errorText('total')}<span class="mt-1 block font-mono text-xs text-rose-700"
								>{errorText('total')}</span
							>{/if}
					</label>
					<label class="text-sm font-semibold">
						Currency
						<select
							class="mt-1 w-full border border-ink bg-paper px-3 py-2 font-normal"
							bind:value={currency}
						>
							<option value="CAD">CAD</option>
							<option value="USD">USD</option>
							<option value="EUR">EUR</option>
						</select>
						{#if errorText('currency')}<span class="mt-1 block font-mono text-xs text-rose-700"
								>{errorText('currency')}</span
							>{/if}
					</label>
					<label class="text-sm font-semibold">
						Payment account
						<select
							class="mt-1 w-full border border-ink bg-paper px-3 py-2 font-normal"
							bind:value={paymentAccountId}
						>
							<option value={null}>Select an account…</option>
							{#each data.referenceData.paymentAccounts as account (account.id)}
								<option value={account.id}>{account.name}</option>
							{/each}
						</select>
						{#if errorText('paymentAccount')}<span
								class="mt-1 block font-mono text-xs text-rose-700"
								>{errorText('paymentAccount')}</span
							>{/if}
					</label>
					<div class="text-sm font-semibold">
						Billable
						<label class="mt-1 flex items-center gap-2 font-normal">
							<input type="checkbox" bind:checked={billable} class="size-4" />
							This expense is billable to a client
						</label>
					</div>
					{#if billable}
						<label class="text-sm font-semibold">
							Client
							<select
								class="mt-1 w-full border border-ink bg-paper px-3 py-2 font-normal"
								bind:value={clientId}
							>
								<option value={null}>Select a client…</option>
								{#each data.referenceData.clients as client (client.id)}
									<option value={client.id}>{client.name}</option>
								{/each}
							</select>
							{#if errorText('client')}<span class="mt-1 block font-mono text-xs text-rose-700"
									>{errorText('client')}</span
								>{/if}
						</label>
					{/if}
					<label class="text-sm font-semibold sm:col-span-2">
						Notes
						<textarea
							class="mt-1 w-full border border-ink bg-paper px-3 py-2 font-normal"
							rows="2"
							bind:value={notes}></textarea>
						{#if errorText('notes')}<span class="mt-1 block font-mono text-xs text-rose-700"
								>{errorText('notes')}</span
							>{/if}
					</label>
				</div>
			</div>

			<div class="border-2 border-ink bg-white/40 p-5">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h2 class="text-lg font-semibold">Line items</h2>
					<span
						class={`px-2 py-1 font-mono text-xs font-bold uppercase ${balanced ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}`}
					>
						{(lineTotal / 100).toFixed(2)} / {totalMinor !== null
							? (totalMinor / 100).toFixed(2)
							: '—'}
						{balanced ? 'balanced' : 'unbalanced'}
					</span>
				</div>
				{#if errorText('lineItems')}<p class="mt-2 font-mono text-xs text-rose-700">
						{errorText('lineItems')}
					</p>{/if}
				<div class="mt-4 space-y-3">
					{#each lineItems as row, index (index)}
						<div class="border border-ink/30 bg-paper p-3">
							<div class="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]">
								<label class="text-xs font-bold uppercase">
									Description
									<input
										class="mt-1 w-full border border-ink bg-white px-2 py-1.5 text-sm font-normal"
										bind:value={row.description}
									/>
									{#if errorText(`lineItems.${index}.description`)}<span
											class="block font-mono text-[11px] text-rose-700"
											>{errorText(`lineItems.${index}.description`)}</span
										>{/if}
								</label>
								<label class="text-xs font-bold uppercase">
									Category
									<select
										class="mt-1 w-full border border-ink bg-white px-2 py-1.5 text-sm font-normal"
										bind:value={row.categoryId}
									>
										<option value="">Select…</option>
										{#each data.referenceData.categories as category (category.id)}
											<option value={category.id}>{category.name}</option>
										{/each}
									</select>
									{#if errorText(`lineItems.${index}.categoryId`)}<span
											class="block font-mono text-[11px] text-rose-700"
											>{errorText(`lineItems.${index}.categoryId`)}</span
										>{/if}
								</label>
								<button
									type="button"
									class="self-end border border-ink px-2 py-1.5 font-mono text-xs font-bold uppercase hover:bg-rose-700 hover:text-white"
									onclick={() => removeLineItem(index)}>Remove</button
								>
							</div>
							<div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
								<label class="text-xs font-bold uppercase"
									>Qty
									<input
										class="mt-1 w-full border border-ink bg-white px-2 py-1.5 text-sm font-normal"
										bind:value={row.quantity}
										inputmode="decimal"
									/>
								</label>
								<label class="text-xs font-bold uppercase"
									>Unit price
									<input
										class="mt-1 w-full border border-ink bg-white px-2 py-1.5 text-sm font-normal"
										bind:value={row.unitPrice}
										inputmode="decimal"
									/>
									{#if errorText(`lineItems.${index}.unitPrice`)}<span
											class="block font-mono text-[11px] text-rose-700"
											>{errorText(`lineItems.${index}.unitPrice`)}</span
										>{/if}
								</label>
								<label class="text-xs font-bold uppercase"
									>Net
									<input
										class="mt-1 w-full border border-ink bg-white px-2 py-1.5 text-sm font-normal"
										bind:value={row.netAmount}
										inputmode="decimal"
									/>
									{#if errorText(`lineItems.${index}.netAmount`)}<span
											class="block font-mono text-[11px] text-rose-700"
											>{errorText(`lineItems.${index}.netAmount`)}</span
										>{/if}
								</label>
								<label class="text-xs font-bold uppercase"
									>Tax
									<input
										class="mt-1 w-full border border-ink bg-white px-2 py-1.5 text-sm font-normal"
										bind:value={row.taxAmount}
										inputmode="decimal"
									/>
									{#if errorText(`lineItems.${index}.taxAmount`)}<span
											class="block font-mono text-[11px] text-rose-700"
											>{errorText(`lineItems.${index}.taxAmount`)}</span
										>{/if}
								</label>
								<label class="text-xs font-bold uppercase"
									>Gross
									<input
										class="mt-1 w-full border border-ink bg-white px-2 py-1.5 text-sm font-normal"
										bind:value={row.grossAmount}
										inputmode="decimal"
										placeholder={rowEffectiveGross(row) !== null
											? (rowEffectiveGross(row)! / 100).toFixed(2)
											: ''}
									/>
									{#if errorText(`lineItems.${index}.grossAmount`)}<span
											class="block font-mono text-[11px] text-rose-700"
											>{errorText(`lineItems.${index}.grossAmount`)}</span
										>{/if}
								</label>
							</div>
						</div>
					{/each}
				</div>
				<button
					type="button"
					class="mt-3 border border-ink px-3 py-1.5 font-mono text-xs font-bold uppercase hover:bg-ink hover:text-paper"
					onclick={addLineItem}>+ Add line item</button
				>
			</div>

			<div class="border-2 border-ink bg-white/40 p-5">
				<h2 class="text-lg font-semibold">Canadian tax components</h2>
				{#if errorText('taxComponents')}<p class="mt-2 font-mono text-xs text-rose-700">
						{errorText('taxComponents')}
					</p>{/if}
				<div class="mt-4 space-y-2">
					{#each taxComponents as component, index (index)}
						<div class="grid items-end gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_8rem_auto]">
							<label class="text-xs font-bold uppercase"
								>Label
								<select
									class="mt-1 w-full border border-ink bg-white px-2 py-1.5 text-sm font-normal"
									bind:value={component.label}
								>
									{#each ['GST', 'HST', 'PST', 'QST', 'OTHER'] as label (label)}
										<option value={label}>{label}</option>
									{/each}
								</select>
								{#if errorText(`taxComponents.${index}.label`)}<span
										class="block font-mono text-[11px] text-rose-700"
										>{errorText(`taxComponents.${index}.label`)}</span
									>{/if}
							</label>
							<label class="text-xs font-bold uppercase"
								>Amount
								<input
									class="mt-1 w-full border border-ink bg-white px-2 py-1.5 text-sm font-normal"
									bind:value={component.amount}
									inputmode="decimal"
								/>
								{#if errorText(`taxComponents.${index}.amount`)}<span
										class="block font-mono text-[11px] text-rose-700"
										>{errorText(`taxComponents.${index}.amount`)}</span
									>{/if}
							</label>
							<label class="text-xs font-bold uppercase"
								>Rate %
								<input
									class="mt-1 w-full border border-ink bg-white px-2 py-1.5 text-sm font-normal"
									bind:value={component.ratePercent}
									inputmode="decimal"
								/>
								{#if errorText(`taxComponents.${index}.ratePercent`)}<span
										class="block font-mono text-[11px] text-rose-700"
										>{errorText(`taxComponents.${index}.ratePercent`)}</span
									>{/if}
							</label>
							<button
								type="button"
								class="border border-ink px-2 py-1.5 font-mono text-xs font-bold uppercase hover:bg-rose-700 hover:text-white"
								onclick={() => removeTaxComponent(index)}>Remove</button
							>
						</div>
					{/each}
				</div>
				<button
					type="button"
					class="mt-3 border border-ink px-3 py-1.5 font-mono text-xs font-bold uppercase hover:bg-ink hover:text-paper"
					onclick={addTaxComponent}>+ Add tax component</button
				>
			</div>

			<div class="border-2 border-ink bg-white/40 p-5">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h2 class="text-lg font-semibold">Destination preview</h2>
					<button
						type="button"
						class="border border-ink px-2 py-1 font-mono text-[11px] font-bold uppercase hover:bg-ink hover:text-paper"
						onclick={refreshPreview}
						disabled={refreshingPreview}>Refresh preview</button
					>
				</div>
				<p class="mt-3 font-mono text-sm break-all">
					<span class="text-ink/50">{preview.destination}/</span><span class="font-bold"
						>{preview.filename}</span
					>
				</p>
			</div>

			<div class="border-2 border-ink bg-white/40 p-5">
				<h2 class="text-lg font-semibold">OCR evidence</h2>
				{#if data.normalizedOcr}
					<div class="mt-3 overflow-x-auto">
						<table class="w-full text-left text-sm">
							<thead>
								<tr class="border-b border-ink/20 font-mono text-[11px] text-ink/50 uppercase">
									<th class="py-1 pr-4">Field</th>
									<th class="py-1 pr-4">Value</th>
									<th class="py-1 pr-4">Confidence</th>
									<th class="py-1">Source</th>
								</tr>
							</thead>
							<tbody>
								{#each Object.entries(data.normalizedOcr) as [key, value] (key)}
									{#if typeof value === 'object' && value !== null && 'value' in (value as object)}
										{@const field = value as {
											value: unknown;
											confidence: unknown;
											source: string;
										}}
										<tr class="border-b border-ink/10">
											<td class="py-1 pr-4 font-mono text-xs">{key}</td>
											<td class="py-1 pr-4">{field.value ?? '—'}</td>
											<td class="py-1 pr-4 font-mono text-xs">
												{typeof field.confidence === 'number'
													? `${Math.round(field.confidence * 100)}%`
													: '—'}
											</td>
											<td class="py-1 font-mono text-[11px] text-ink/50">{field.source}</td>
										</tr>
									{/if}
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<p class="mt-3 text-sm text-ink/60">No successful OCR run retained yet.</p>
				{/if}
				{#if data.rawOcrJson}
					<details class="mt-4">
						<summary class="cursor-pointer font-mono text-xs font-bold uppercase"
							>Raw provider response</summary
						>
						<pre
							class="mt-2 max-h-72 overflow-auto border border-ink/20 bg-paper p-3 font-mono text-[11px] leading-4">{data.rawOcrJson}</pre>
					</details>
				{/if}
			</div>

			<div class="border-2 border-ink bg-white/40 p-5">
				<h2 class="text-lg font-semibold">Audit history</h2>
				<ul class="mt-3 space-y-2 text-sm">
					{#each data.events as event (event.createdAt + event.action)}
						<li class="border-b border-ink/10 pb-2">
							<span class="font-mono text-xs font-bold uppercase">{event.action}</span>
							<span class="ml-2 font-mono text-[11px] text-ink/50">
								{new Date(event.createdAt).toLocaleString()} · {event.actorLabel}
							</span>
						</li>
					{/each}
				</ul>
			</div>

			<div
				class="sticky bottom-0 border-2 border-ink bg-paper p-4 shadow-[0_-4px_0_rgba(23,35,29,0.08)]"
			>
				<form
					method="POST"
					action="?/save"
					use:enhance={() => {
						return async ({ result, update }) => {
							await update({ reset: false });
							if (result.type === 'success') {
								if ((result.data as { approved?: boolean })?.approved) {
									await goto('/');
									return;
								}
								await invalidateAll();
								await refreshPreview();
							}
						};
					}}
				>
					<input type="hidden" name="payload" value={payload} />
					<div class="flex flex-wrap items-center gap-2">
						<button
							id="save-button"
							type="submit"
							class="border border-ink px-4 py-2 font-mono text-xs font-bold uppercase hover:bg-ink hover:text-paper"
							title="Save draft (S)"
						>
							Save draft (S)
						</button>
						<button
							id="approve-button"
							type="submit"
							formaction="?/approve"
							name="intent"
							value="approve"
							class="bg-forest px-4 py-2 font-mono text-xs font-extrabold text-white uppercase shadow-[3px_3px_0_#17231d] hover:-translate-y-0.5"
							title="Approve (A)"
							disabled={data.expense.status !== 'needs_review'}
						>
							Approve (A)
						</button>
						<button
							id="retry-ocr-button"
							type="submit"
							formaction="?/retry-ocr"
							class="border border-ink px-4 py-2 font-mono text-xs font-bold uppercase hover:bg-ink hover:text-paper"
							title="Retry OCR (R)"
						>
							Retry OCR (R)
						</button>
					</div>
				</form>
				<form
					method="POST"
					action="?/reject"
					class="mt-3"
					use:enhance={() => {
						return async ({ result, update }) => {
							await update({ reset: false });
							if (result.type === 'success' && (result.data as { rejected?: boolean })?.rejected) {
								await goto('/');
							}
						};
					}}
				>
					<label class="text-xs font-bold uppercase" for="reject-reason">Rejection reason</label>
					<div class="mt-1 flex flex-wrap gap-2">
						<input
							id="reject-reason"
							name="reason"
							class="min-w-0 flex-1 border border-ink bg-white px-3 py-2 text-sm"
							bind:value={rejectReason}
							placeholder="Why is this receipt rejected?"
						/>
						<button
							type="submit"
							class="bg-coral px-4 py-2 font-mono text-xs font-extrabold text-white uppercase shadow-[3px_3px_0_#17231d] hover:-translate-y-0.5"
							title="Reject (X focuses reason)"
							disabled={data.expense.status !== 'needs_review'}
						>
							Reject (X)
						</button>
					</div>
				</form>
				{#if data.expense.status === 'approved'}
					<form
						method="POST"
						action="?/reopen"
						class="mt-3"
						use:enhance={() => {
							return async ({ update }) => {
								await update({ reset: false });
								await invalidateAll();
							};
						}}
					>
						<button
							type="submit"
							class="border border-ink px-4 py-2 font-mono text-xs font-bold uppercase hover:bg-ink hover:text-paper"
						>
							Reopen for review
						</button>
					</form>
				{/if}
				{#if form?.fieldErrors}
					<div class="mt-3 border border-rose-600 bg-rose-100 p-3">
						<p class="font-mono text-xs font-bold text-rose-800 uppercase">Fix before approving</p>
						<ul class="mt-1 list-disc pl-4 text-xs text-rose-900">
							{#each Object.entries(form.fieldErrors) as [key, message] (key)}
								<li><span class="font-mono">{key}</span>: {message}</li>
							{/each}
						</ul>
					</div>
				{/if}
			</div>
		</div>
	</section>
</main>
