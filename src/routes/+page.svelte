<script lang="ts">
	import { onMount } from 'svelte';

	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type QueueItem = PageData['queue'][number];
	type DisplayStatus =
		| 'moving'
		| 'ocr_queued'
		| 'ocr_running'
		| 'ocr_retrying'
		| 'needs_review'
		| 'ocr_failed'
		| 'intake_failed'
		| 'approved'
		| 'rejected'
		| 'reopened';

	type QueueFilter =
		| 'all'
		| 'processing'
		| 'needs_review'
		| 'ocr_failed'
		| 'duplicates'
		| 'approved'
		| 'rejected'
		| 'reopened';

	const filters: { id: QueueFilter; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'needs_review', label: 'Needs review' },
		{ id: 'processing', label: 'Processing' },
		{ id: 'ocr_failed', label: 'OCR failure' },
		{ id: 'duplicates', label: 'Duplicates' },
		{ id: 'approved', label: 'Approved' },
		{ id: 'rejected', label: 'Rejected' },
		{ id: 'reopened', label: 'Reopened' }
	];

	let activeFilter = $state<QueueFilter>('all');
	let searchQuery = $state('');
	const filterStorageKey = 'expensifier.queue-filter';

	onMount(() => {
		const savedFilter = sessionStorage.getItem(filterStorageKey);
		if (filters.some((filter) => filter.id === savedFilter)) {
			activeFilter = savedFilter as QueueFilter;
		}
	});

	function selectFilter(filter: QueueFilter) {
		activeFilter = filter;
		sessionStorage.setItem(filterStorageKey, filter);
	}

	const reviewByDocument = $derived(new Map(data.review.map((entry) => [entry.documentId, entry])));

	const statusStyle = {
		moving: 'bg-sky-100 text-sky-800',
		ocr_queued: 'bg-violet-100 text-violet-800',
		ocr_running: 'bg-blue-100 text-blue-800',
		ocr_retrying: 'bg-amber-100 text-amber-900',
		needs_review: 'bg-emerald-100 text-emerald-800',
		ocr_failed: 'bg-rose-100 text-rose-800',
		intake_failed: 'bg-rose-100 text-rose-800',
		approved: 'bg-forest text-white',
		rejected: 'bg-rose-100 text-rose-800',
		reopened: 'bg-amber-100 text-amber-900'
	} as const;

	const statusLabel = {
		moving: 'Moving',
		ocr_queued: 'OCR queued',
		ocr_running: 'Reading receipt',
		ocr_retrying: 'OCR retrying',
		needs_review: 'Ready for review',
		ocr_failed: 'OCR failed',
		intake_failed: 'Intake failed',
		approved: 'Approved',
		rejected: 'Rejected',
		reopened: 'Reopened'
	} as const;

	function displayStatus(item: QueueItem): DisplayStatus {
		if (item.document.status === 'failed' || item.jobStatus === 'failed') return 'intake_failed';
		if (item.jobStatus !== 'succeeded') return 'moving';
		const expense = reviewByDocument.get(item.document.id);
		if (expense?.status === 'approved') return 'approved';
		if (expense?.status === 'rejected') return 'rejected';
		if (expense?.status === 'needs_review' && expense.reopenedAt) return 'reopened';
		if (item.ocrStatus === 'failed') return 'ocr_failed';
		if (item.ocrStatus === 'running') return 'ocr_running';
		if (item.ocrStatus === 'pending' && item.ocrAttemptCount > 0) return 'ocr_retrying';
		if (item.ocrStatus === 'succeeded') return 'needs_review';
		return 'ocr_queued';
	}

	function matchesFilter(item: QueueItem, filter: QueueFilter): boolean {
		if (filter === 'all') return true;
		if (filter === 'duplicates') return !!item.document.duplicateOfDocumentId;
		if (filter === 'processing') {
			return ['moving', 'ocr_queued', 'ocr_running', 'ocr_retrying'].includes(displayStatus(item));
		}
		return displayStatus(item) === filter;
	}

	function matchesSearch(item: QueueItem): boolean {
		const query = searchQuery.trim().toLocaleLowerCase();
		if (!query) return true;
		const status = displayStatus(item);
		return [
			item.document.originalFilename,
			item.document.extension,
			item.document.contentHash,
			status,
			statusLabel[status],
			resultSummary(item) ?? ''
		].some((value) => value.toLocaleLowerCase().includes(query));
	}

	const filteredQueue = $derived(
		data.queue.filter((item) => matchesFilter(item, activeFilter) && matchesSearch(item))
	);

	function countFilter(filter: QueueFilter): number {
		return data.queue.filter((item) => matchesFilter(item, filter)).length;
	}

	function expenseIdFor(item: QueueItem): string | null {
		return reviewByDocument.get(item.document.id)?.expenseId ?? null;
	}

	function resultSummary(item: QueueItem): string | null {
		if (!item.normalizedOcrJson) return null;
		try {
			const value = JSON.parse(item.normalizedOcrJson);
			const merchant = value?.merchantName?.value;
			const total = value?.totalAmount?.value;
			const currency = value?.currencyCode?.value;
			return (
				[merchant, total && currency ? `${currency} ${total}` : total]
					.filter(Boolean)
					.join(' / ') || null
			);
		} catch {
			return null;
		}
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}
</script>

<svelte:head>
	<title>Review queue | Expensifier</title>
	<meta
		name="description"
		content="Durable receipt intake, OCR, and review queue for Expensifier."
	/>
</svelte:head>

<main class="mx-auto min-h-screen max-w-7xl px-5 py-6 sm:px-8 sm:py-10">
	<header
		class="flex flex-col gap-6 border-b-2 border-ink pb-7 sm:flex-row sm:items-end sm:justify-between"
	>
		<div>
			<p class="font-mono text-xs font-bold tracking-[0.24em] text-forest uppercase">
				Phase 05 / Review &amp; File Completion
			</p>
			<h1 class="mt-2 text-4xl font-semibold tracking-[-0.045em] sm:text-6xl">
				Receipts arrive.<br />Evidence remains.
			</h1>
		</div>
		<div class="flex flex-wrap items-center gap-3 sm:max-w-xs sm:justify-end">
			<div class="mr-1 text-right">
				<p class="text-sm font-semibold">{data.user.name}</p>
				<p class="font-mono text-xs text-ink/60">{data.user.role}</p>
			</div>
			{#if data.user.role === 'admin'}
				<a
					href="/settings"
					class="border border-ink/30 px-3 py-1.5 text-xs font-bold tracking-wide uppercase hover:bg-forest hover:text-paper"
					>Settings</a
				>
			{/if}
			<form method="POST" action="?/sign-out">
				<button
					class="border border-ink/30 px-3 py-1.5 text-xs font-bold tracking-wide uppercase hover:bg-ink hover:text-paper"
				>
					Sign out
				</button>
			</form>
		</div>
	</header>

	<section class="grid grid-cols-2 gap-3 py-6 lg:grid-cols-4">
		<div class="border border-ink/30 bg-white/35 p-4">
			<p class="font-mono text-[11px] font-bold tracking-[0.16em] text-ink/50 uppercase">Total</p>
			<p class="mt-2 text-3xl font-semibold">{data.queue.length}</p>
		</div>
		<div class="border border-ink/30 bg-white/35 p-4">
			<p class="font-mono text-[11px] font-bold tracking-[0.16em] text-ink/50 uppercase">
				Active OCR
			</p>
			<p class="mt-2 text-3xl font-semibold">
				{data.queue.filter(
					(item) =>
						displayStatus(item) === 'ocr_running' ||
						displayStatus(item) === 'ocr_queued' ||
						displayStatus(item) === 'ocr_retrying'
				).length}
			</p>
		</div>
		<div class="border border-ink/30 bg-white/35 p-4">
			<p class="font-mono text-[11px] font-bold tracking-[0.16em] text-ink/50 uppercase">
				OCR ready
			</p>
			<p class="mt-2 text-3xl font-semibold">
				{data.queue.filter((item) => displayStatus(item) === 'needs_review').length}
			</p>
		</div>
		<div class="border border-ink/30 bg-white/35 p-4">
			<p class="font-mono text-[11px] font-bold tracking-[0.16em] text-ink/50 uppercase">
				Failures
			</p>
			<p class="mt-2 text-3xl font-semibold">
				{data.queue.filter(
					(item) => displayStatus(item) === 'ocr_failed' || displayStatus(item) === 'intake_failed'
				).length}
			</p>
		</div>
	</section>

	<section class="grid gap-6 pb-10 lg:grid-cols-[1fr_19rem]">
		<div class="border-2 border-ink bg-paper shadow-[7px_7px_0_#17231d]">
			<div class="flex items-center justify-between border-b-2 border-ink p-5">
				<div>
					<p class="font-mono text-xs tracking-[0.18em] uppercase">Retained extraction ledger</p>
					<h2 class="mt-1 text-2xl font-semibold">Review queue</h2>
				</div>
				<span
					class="grid size-11 place-items-center rounded-full bg-forest font-mono text-sm font-bold text-white"
				>
					{filteredQueue.length}
				</span>
			</div>

			<div
				class="flex flex-col gap-3 border-b border-ink/20 px-5 py-3 xl:flex-row xl:items-center xl:justify-between"
			>
				<div class="flex flex-wrap gap-2">
					{#each filters as filter (filter.id)}
						<button
							type="button"
							class={`px-2.5 py-1 font-mono text-xs font-bold uppercase ${activeFilter === filter.id ? 'bg-ink text-paper' : 'border border-ink/30 hover:bg-ink/10'}`}
							onclick={() => selectFilter(filter.id)}
						>
							{filter.label} ({countFilter(filter.id)})
						</button>
					{/each}
				</div>
				<label class="block min-w-56 xl:w-72">
					<span class="sr-only">Search expenses</span>
					<input
						type="search"
						class="w-full border border-ink bg-white px-3 py-1.5 text-sm"
						placeholder="Search current list..."
						bind:value={searchQuery}
					/>
				</label>
			</div>

			{#if filteredQueue.length === 0}
				<div class="p-10 text-center sm:p-16">
					<p class="font-mono text-sm text-ink/60">
						{searchQuery.trim()
							? 'NO MATCHING EXPENSES'
							: activeFilter === 'all'
								? 'INBOX CLEAR'
								: 'NOTHING IN THIS VIEW'}
					</p>
					<p class="mx-auto mt-3 max-w-md text-sm leading-6 text-ink/70">
						Drop a PDF, JPEG, or PNG into the configured inbox. Stable files are hashed, moved, and
						recorded automatically.
					</p>
				</div>
			{:else}
				<div class="divide-y divide-ink/20">
					{#each filteredQueue as item (item.document.id)}
						{@const state = displayStatus(item)}
						<article class="grid gap-4 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
							<div class="min-w-0">
								<div class="flex min-w-0 items-center gap-3">
									<span
										class="border border-ink/25 px-2 py-1 font-mono text-[10px] font-bold uppercase"
										>{item.document.extension}</span
									>
									<p class="truncate font-semibold">{item.document.originalFilename}</p>
								</div>
								<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-ink/50">
									<span>{formatBytes(item.document.byteSize)}</span>
									<span>{item.document.contentHash.slice(0, 12)}</span>
									<span>{new Date(item.document.createdAt).toLocaleString()}</span>
									<span>ATTEMPT {item.attemptCount}/{item.maxAttempts}</span>
								</div>
								{#if item.document.duplicateOfDocumentId}
									<p class="mt-2 text-xs font-semibold text-amber-800">
										Matches document {item.document.duplicateOfDocumentId.slice(0, 8)}
									</p>
								{/if}
								{#if resultSummary(item)}
									<p class="mt-2 text-sm text-forest">{resultSummary(item)}</p>
								{/if}
								{#if item.ocrErrorCode || item.errorCode}
									<p class="mt-2 font-mono text-xs text-rose-700">
										{item.ocrErrorCode ?? item.errorCode}
									</p>
									{#if item.ocrErrorSummary}<p class="mt-1 text-xs text-rose-700">
											{item.ocrErrorSummary}
										</p>{/if}
								{/if}
							</div>
							<div class="flex flex-col items-start gap-2 sm:items-end">
								<span
									class={`w-fit px-2.5 py-1 font-mono text-xs font-bold uppercase ${statusStyle[state]}`}
									>{statusLabel[state]}</span
								>
								{#if item.document.duplicateOfDocumentId}<span
										class="bg-amber-100 px-2 py-1 font-mono text-[10px] font-bold text-amber-900 uppercase"
										>Duplicate</span
									>{/if}
								{#if expenseIdFor(item)}
									<a
										href="/review/{expenseIdFor(item)}"
										class="bg-coral px-2.5 py-1 font-mono text-xs font-extrabold text-white uppercase shadow-[3px_3px_0_#17231d] hover:-translate-y-0.5"
									>
										Review
									</a>
								{/if}
								{#if state === 'ocr_failed'}
									<form method="POST" action="?/retry-ocr">
										<input type="hidden" name="documentId" value={item.document.id} />
										<button
											class="border border-ink px-2.5 py-1 font-mono text-xs font-bold uppercase hover:bg-ink hover:text-paper"
											>Retry OCR</button
										>
									</form>
								{/if}
							</div>
						</article>
					{/each}
				</div>
			{/if}
		</div>

		<aside class="flex flex-col justify-between bg-forest p-6 text-white">
			<div>
				<p class="font-mono text-xs font-bold tracking-[0.2em] text-white/55 uppercase">
					OCR monitor
				</p>
				<h2 class="mt-4 text-3xl font-semibold tracking-tight">
					Normalized fields. Original evidence.
				</h2>
				<ul class="mt-7 space-y-3 text-sm text-white/70">
					<li class="border-t border-white/20 pt-3">Stable-file checks</li>
					<li class="border-t border-white/20 pt-3">SHA-256 duplicate links</li>
					<li class="border-t border-white/20 pt-3">Atomic processing moves</li>
					<li class="border-t border-white/20 pt-3">Bounded retry and restart recovery</li>
					<li class="border-t border-white/20 pt-3">Raw response retention</li>
					<li class="border-t border-white/20 pt-3">Field confidence and provenance</li>
				</ul>
			</div>
			<div class="mt-10">
				<form method="POST" action="?/reconcile-inbox">
					<button
						class="w-full bg-coral px-5 py-4 text-sm font-extrabold tracking-[0.1em] uppercase shadow-[4px_4px_0_#f5f1e8] transition hover:-translate-y-0.5 hover:shadow-[6px_6px_0_#f5f1e8] active:translate-y-0 active:shadow-none"
					>
						Reconcile inbox
					</button>
				</form>
				{#if form?.message}<p class="mt-4 font-mono text-xs text-white/70">{form.message}</p>{/if}
			</div>
		</aside>
	</section>
</main>
