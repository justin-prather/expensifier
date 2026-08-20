<script lang="ts">
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head><title>Create admin | Expensifier</title></svelte:head>

<main
	class="mx-auto grid min-h-screen max-w-6xl items-center gap-10 px-5 py-12 lg:grid-cols-2 lg:px-10"
>
	<section>
		<p class="font-mono text-xs font-bold tracking-[0.22em] text-forest uppercase">
			First run / One-time setup
		</p>
		<h1 class="mt-4 text-5xl font-semibold tracking-[-0.055em] sm:text-7xl">
			Name the first keeper of the books.
		</h1>
		<p class="mt-6 max-w-lg text-lg leading-8 text-ink/65">
			This creates the only publicly available account. Afterward, registration closes and future
			accountants will require an admin invitation.
		</p>
	</section>

	<section class="border-2 border-ink bg-paper p-6 shadow-[8px_8px_0_#174a36] sm:p-9">
		<form method="POST" class="space-y-5">
			<label class="block">
				<span class="text-xs font-extrabold tracking-[0.12em] uppercase">Display name</span>
				<input
					name="name"
					autocomplete="name"
					required
					value={form?.name ?? ''}
					class="mt-2 w-full border-2 border-ink bg-white/60 px-4 py-3 outline-none focus:border-coral"
				/>
			</label>
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
					autocomplete="new-password"
					minlength="8"
					required
					class="mt-2 w-full border-2 border-ink bg-white/60 px-4 py-3 outline-none focus:border-coral"
				/>
				<span class="mt-2 block font-mono text-[11px] text-ink/50">MINIMUM 8 CHARACTERS</span>
			</label>
			{#if form?.message}<p class="border-l-4 border-coral pl-3 text-sm text-coral">
					{form.message}
				</p>{/if}
			<button
				class="w-full bg-coral px-5 py-4 text-sm font-extrabold tracking-[0.12em] text-white uppercase hover:bg-forest"
				>Create admin account</button
			>
		</form>
	</section>
</main>
