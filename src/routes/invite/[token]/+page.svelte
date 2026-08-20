<script lang="ts">
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>Accept invitation | Expensifier</title></svelte:head>

<main class="grid min-h-screen lg:grid-cols-[1.05fr_0.95fr]">
	<section class="flex items-center justify-center px-5 py-12 sm:px-10">
		<div class="w-full max-w-lg">
			<p class="font-mono text-xs font-bold tracking-[0.22em] text-forest uppercase">
				Expensifier / Invitation
			</p>
			{#if data.invitation}
				<h1 class="mt-4 text-5xl font-semibold tracking-[-0.05em]">
					Take your place at the ledger.
				</h1>
				<p class="mt-4 leading-7 text-ink/65">
					<strong>{data.invitation.email}</strong> has been invited as
					<span class="font-mono text-sm font-bold uppercase">{data.invitation.role}</span>.
				</p>
				<form method="POST" class="mt-9 space-y-5">
					<label class="block"
						><span class="text-xs font-extrabold tracking-[0.12em] uppercase">Display name</span
						><input
							name="name"
							autocomplete="name"
							required
							value={form?.name ?? ''}
							class="mt-2 w-full border-2 border-ink bg-white/60 px-4 py-3 outline-none focus:border-coral"
						/></label
					>
					<label class="block"
						><span class="text-xs font-extrabold tracking-[0.12em] uppercase">Password</span><input
							name="password"
							type="password"
							autocomplete="new-password"
							minlength="8"
							required
							class="mt-2 w-full border-2 border-ink bg-white/60 px-4 py-3 outline-none focus:border-coral"
						/><span class="mt-2 block font-mono text-[11px] text-ink/50">MINIMUM 8 CHARACTERS</span
						></label
					>
					{#if form?.message}<p class="border-l-4 border-coral pl-3 text-sm text-coral">
							{form.message}
						</p>{/if}
					<button
						class="w-full bg-coral px-5 py-4 text-sm font-extrabold tracking-[0.12em] text-white uppercase hover:bg-forest"
						>Create account</button
					>
				</form>
			{:else}
				<h1 class="mt-4 text-5xl font-semibold tracking-[-0.05em]">This key no longer turns.</h1>
				<p class="mt-5 border-l-4 border-coral pl-4 leading-7 text-ink/65">
					{data.unavailableMessage}
				</p>
				<a
					href="/login"
					class="mt-8 inline-block border-2 border-ink px-5 py-3 text-sm font-extrabold tracking-wide uppercase hover:bg-ink hover:text-paper"
					>Go to sign in</a
				>
			{/if}
		</div>
	</section>
	<aside class="hidden bg-ink p-12 text-paper lg:flex lg:flex-col lg:justify-between">
		<p class="font-mono text-xs tracking-[0.2em] text-white/45 uppercase">
			One person / One link / One use
		</p>
		<p class="max-w-lg text-5xl leading-[1.05] font-semibold tracking-[-0.04em]">
			Every expense is reviewed. Every reviewer is known.
		</p>
		<p class="font-mono text-xs text-white/45">ADMIN + ACCOUNTANT ACCESS</p>
	</aside>
</main>
