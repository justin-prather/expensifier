<script lang="ts">
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head><title>Sign in | Expensifier</title></svelte:head>

<main class="grid min-h-screen lg:grid-cols-[0.9fr_1.1fr]">
	<section class="flex items-center justify-center px-5 py-12 sm:px-10">
		<div class="w-full max-w-md">
			<p class="font-mono text-xs font-bold tracking-[0.22em] text-forest uppercase">
				Expensifier / Access
			</p>
			<h1 class="mt-4 text-5xl font-semibold tracking-[-0.05em]">Return to the ledger.</h1>
			<p class="mt-4 max-w-sm leading-7 text-ink/65">
				Sign in to inspect processing jobs and continue building the expense workflow.
			</p>

			<form method="POST" class="mt-10 space-y-5">
				<label class="block">
					<span class="text-xs font-extrabold tracking-[0.12em] uppercase">Email</span>
					<input
						name="email"
						type="email"
						autocomplete="email"
						required
						value={form?.email ?? ''}
						class="mt-2 w-full border-2 border-ink bg-white/60 px-4 py-3 outline-none focus:border-coral"
					/>
				</label>
				<label class="block">
					<span class="text-xs font-extrabold tracking-[0.12em] uppercase">Password</span>
					<input
						name="password"
						type="password"
						autocomplete="current-password"
						minlength="8"
						required
						class="mt-2 w-full border-2 border-ink bg-white/60 px-4 py-3 outline-none focus:border-coral"
					/>
				</label>
				{#if form?.message}<p class="border-l-4 border-coral pl-3 text-sm text-coral">
						{form.message}
					</p>{/if}
				<button
					class="w-full bg-ink px-5 py-4 text-sm font-extrabold tracking-[0.12em] text-paper uppercase hover:bg-forest"
					>Sign in</button
				>
			</form>
		</div>
	</section>
	<aside class="hidden bg-forest p-12 text-paper lg:flex lg:flex-col lg:justify-between">
		<p class="font-mono text-xs tracking-[0.2em] text-white/55 uppercase">Private over Tailscale</p>
		<p class="max-w-xl text-5xl leading-[1.05] font-semibold tracking-[-0.04em]">
			Receipts enter as files. They leave as reviewed, structured expenses.
		</p>
		<p class="font-mono text-xs text-white/55">BUN / SVELTEKIT / EFFECT V4 / SQLITE</p>
	</aside>
</main>
