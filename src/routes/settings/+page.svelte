<script lang="ts">
	const sections = [
		{
			href: '/settings/reference',
			label: 'Reference data',
			description:
				'Payment accounts, categories, clients, and the vendor rules that classify receipts automatically.'
		},
		{
			href: '/settings/templates',
			label: 'File templates',
			description: 'Filename and destination templates with a live preview of the rendered paths.'
		},
		{
			href: '/settings/users',
			label: 'Users and invitations',
			description: 'Invite people, assign roles, and revoke pending invitations.'
		}
	];
</script>

<svelte:head>
	<title>Settings | Expensifier</title>
	<meta name="description" content="Administer Expensifier reference data, templates, and users." />
</svelte:head>

<main class="mx-auto min-h-screen max-w-6xl px-5 py-6 sm:px-8 sm:py-10">
	<header
		class="flex flex-col gap-5 border-b-2 border-ink pb-7 sm:flex-row sm:items-end sm:justify-between"
	>
		<div>
			<a
				href="/"
				class="font-mono text-xs font-bold tracking-[0.18em] text-forest uppercase hover:text-coral"
			>
				← Processing lab
			</a>
			<h1 class="mt-3 text-4xl font-semibold tracking-[-0.045em] sm:text-6xl">Settings.</h1>
			<p class="mt-3 max-w-2xl text-ink/65">
				The control room: reference data, deterministic rules, file templates, and people.
			</p>
		</div>
		<p class="font-mono text-xs font-bold tracking-[0.2em] text-forest uppercase">Admin settings</p>
	</header>

	<section class="grid gap-6 py-8 md:grid-cols-3">
		{#each sections as section (section.href)}
			<a
				href={section.href}
				class="group flex flex-col justify-between border-2 border-ink bg-white/45 p-6 shadow-[6px_6px_0_rgba(27,42,38,0.15)] transition-transform hover:-translate-y-1"
			>
				<div>
					<h2 class="text-2xl font-semibold">{section.label}</h2>
					<p class="mt-3 text-sm leading-6 text-ink/65">{section.description}</p>
				</div>
				<p
					class="mt-6 font-mono text-xs font-bold tracking-[0.18em] text-forest uppercase group-hover:text-coral"
				>
					Open →
				</p>
			</a>
		{/each}
	</section>
</main>
