<script lang="ts">
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const statusStyle = {
		pending: 'bg-amber-100 text-amber-800',
		running: 'bg-sky-100 text-sky-800',
		succeeded: 'bg-emerald-100 text-emerald-800',
		failed: 'bg-rose-100 text-rose-800'
	} as const;
</script>

<svelte:head>
	<title>Processing Lab | Expensifier</title>
	<meta name="description" content="The Expensifier Phase 1 application foundation." />
</svelte:head>

<main class="mx-auto min-h-screen max-w-6xl px-5 py-6 sm:px-8 sm:py-10">
	<header
		class="flex flex-col gap-6 border-b-2 border-ink pb-7 sm:flex-row sm:items-end sm:justify-between"
	>
		<div>
			<p class="font-mono text-xs font-bold tracking-[0.24em] text-forest uppercase">
				Phase 01 / Foundation
			</p>
			<h1 class="mt-2 text-4xl font-semibold tracking-[-0.045em] sm:text-6xl">
				Expense machinery,<br />under observation.
			</h1>
		</div>
		<div class="flex items-center gap-3 sm:flex-col sm:items-end">
			<div class="text-right">
				<p class="text-sm font-semibold">{data.user.name}</p>
				<p class="font-mono text-xs text-ink/60">{data.user.role}</p>
			</div>
			<form method="POST" action="?/sign-out">
				<button
					class="border border-ink/30 px-3 py-1.5 text-xs font-bold tracking-wide uppercase hover:bg-ink hover:text-paper"
				>
					Sign out
				</button>
			</form>
		</div>
	</header>

	<section class="grid gap-6 py-8 lg:grid-cols-[1.15fr_0.85fr]">
		<div class="border-2 border-ink bg-paper shadow-[7px_7px_0_#17231d]">
			<div class="flex items-center justify-between border-b-2 border-ink p-5">
				<div>
					<p class="font-mono text-xs tracking-[0.18em] uppercase">Durable job ledger</p>
					<h2 class="mt-1 text-2xl font-semibold">Fake OCR runs</h2>
				</div>
				<span
					class="grid size-11 place-items-center rounded-full bg-forest font-mono text-sm font-bold text-white"
				>
					{data.jobs.length}
				</span>
			</div>

			{#if data.jobs.length === 0}
				<div class="p-10 text-center">
					<p class="font-mono text-sm text-ink/60">NO JOBS RECORDED</p>
					<p class="mx-auto mt-3 max-w-sm text-sm leading-6 text-ink/70">
						Run the first probe to exercise Effect v4, SQLite migrations, and the replaceable OCR
						boundary.
					</p>
				</div>
			{:else}
				<div class="divide-y divide-ink/20">
					{#each data.jobs as job (job.id)}
						<article class="grid gap-3 p-5 sm:grid-cols-[1fr_auto] sm:items-center">
							<div class="min-w-0">
								<p class="truncate font-mono text-xs text-ink/50">{job.id}</p>
								<p class="mt-1 font-semibold">Fake receipt extraction</p>
								<p class="mt-1 text-xs text-ink/60">{new Date(job.updatedAt).toLocaleString()}</p>
							</div>
							<span
								class={`w-fit px-2.5 py-1 font-mono text-xs font-bold uppercase ${statusStyle[job.status]}`}
							>
								{job.status}
							</span>
						</article>
					{/each}
				</div>
			{/if}
		</div>

		<aside class="flex flex-col justify-between bg-forest p-6 text-white sm:p-8">
			<div>
				<p class="font-mono text-xs font-bold tracking-[0.2em] text-white/60 uppercase">
					Foundation status
				</p>
				<h2 class="mt-4 text-3xl font-semibold tracking-tight">
					The application shell is ready for the workflow.
				</h2>
				<ul class="mt-7 space-y-3 text-sm text-white/75">
					<li class="border-t border-white/20 pt-3">Effect v4 ManagedRuntime</li>
					<li class="border-t border-white/20 pt-3">Effect SQL with Bun SQLite</li>
					<li class="border-t border-white/20 pt-3">Replaceable OcrService Layer</li>
					<li class="border-t border-white/20 pt-3">Better Auth protected route</li>
					<li class="border-t border-white/20 pt-3">Validated managed storage and readiness</li>
				</ul>
			</div>

			<div class="mt-12">
				<form method="POST" action="?/run-ocr">
					<button
						class="w-full bg-coral px-5 py-4 text-sm font-extrabold tracking-[0.1em] text-white uppercase shadow-[4px_4px_0_#f5f1e8] transition hover:-translate-y-0.5 hover:shadow-[6px_6px_0_#f5f1e8] active:translate-y-0 active:shadow-none"
					>
						Run fake OCR probe
					</button>
				</form>
				{#if form?.message}
					<p class="mt-4 font-mono text-xs text-white/75">{form.message}</p>
				{/if}
			</div>
		</aside>
	</section>
</main>
