<script lang="ts">
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Ref = PageData['paymentAccounts'][number];
	type Rule = PageData['rules'][number];

	const sections = [
		{
			kind: 'payment_account' as const,
			title: 'Payment accounts',
			items: () => data.paymentAccounts
		},
		{ kind: 'category' as const, title: 'Categories', items: () => data.categories },
		{ kind: 'client' as const, title: 'Clients', items: () => data.clients }
	];

	let editingId = $state<string | null>(null);
	let editingName = $state('');
	let editingRuleId = $state<string | null>(null);

	function startEdit(ref: Ref) {
		editingRuleId = null;
		editingId = ref.id;
		editingName = ref.name;
	}

	function startRuleEdit(rule: Rule) {
		editingId = null;
		editingRuleId = rule.id;
	}
</script>

<svelte:head>
	<title>Reference data | Expensifier</title>
	<meta
		name="description"
		content="Manage payment accounts, categories, clients, and vendor classification rules."
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
			<h1 class="mt-3 text-4xl font-semibold tracking-[-0.045em] sm:text-6xl">Reference data.</h1>
			<p class="mt-3 max-w-2xl text-ink/65">
				Records used by past expenses can be deactivated but not deleted. Vendor rules classify new
				receipts deterministically before OCR suggestions.
			</p>
		</div>
		<p class="font-mono text-xs font-bold tracking-[0.2em] text-forest uppercase">Admin settings</p>
	</header>

	{#if form?.message}
		<div class="mt-6 border-l-4 border-coral bg-white/55 px-4 py-3 text-sm font-semibold">
			{form.message}
		</div>
	{/if}

	<section class="grid gap-6 py-8 lg:grid-cols-3">
		{#each sections as section (section.kind)}
			{@const items = section.items()}
			<div class="border-2 border-ink bg-white/45 p-5">
				<div class="flex items-center justify-between">
					<h2 class="text-xl font-semibold">{section.title}</h2>
					<span class="bg-sand px-2 py-1 font-mono text-xs font-bold uppercase">{items.length}</span
					>
				</div>
				<form method="POST" action="?/create" class="mt-4 flex gap-2">
					<input type="hidden" name="kind" value={section.kind} />
					<input
						name="name"
						required
						maxlength={120}
						placeholder={`New ${section.title.toLowerCase().replace(/s$/, '')} name`}
						class="w-full border border-ink bg-paper px-3 py-2 text-sm"
					/>
					<button
						class="border border-ink px-3 py-2 font-mono text-xs font-extrabold uppercase hover:bg-ink hover:text-paper"
						>Add</button
					>
				</form>
				<ul class="mt-4 divide-y divide-ink/15">
					{#each items as item (item.id)}
						<li class="py-3">
							{#if editingId === item.id}
								<form method="POST" action="?/rename" class="flex gap-2">
									<input type="hidden" name="kind" value={section.kind} />
									<input type="hidden" name="id" value={item.id} />
									<input
										name="name"
										value={editingName}
										required
										maxlength={120}
										class="w-full border border-ink bg-white px-3 py-1.5 text-sm"
									/>
									<button
										class="border border-ink px-2 py-1.5 font-mono text-xs font-bold uppercase hover:bg-ink hover:text-paper"
										>Save</button
									>
								</form>
							{:else}
								<div class="flex flex-wrap items-center justify-between gap-2">
									<div class="min-w-0">
										<p class="truncate text-sm font-semibold">{item.name}</p>
										<p class="font-mono text-[11px] uppercase">
											<span class={item.active ? 'text-emerald-700' : 'text-coral'}
												>{item.active ? 'active' : 'inactive'}</span
											>
											{#if item.inUse}<span class="text-ink/45"> · in use</span>{/if}
										</p>
									</div>
									<div class="flex gap-2">
										<button
											type="button"
											class="border border-ink/40 px-2 py-1 font-mono text-[11px] font-bold uppercase hover:bg-ink hover:text-paper"
											onclick={() => startEdit(item)}>Rename</button
										>
										<form method="POST" action="?/toggle">
											<input type="hidden" name="kind" value={section.kind} />
											<input type="hidden" name="id" value={item.id} />
											<input type="hidden" name="active" value={item.active ? 'false' : 'true'} />
											<button
												class="border border-ink/40 px-2 py-1 font-mono text-[11px] font-bold uppercase hover:bg-ink hover:text-paper"
												>{item.active ? 'Deactivate' : 'Activate'}</button
											>
										</form>
										{#if !item.inUse}
											<form method="POST" action="?/delete">
												<input type="hidden" name="kind" value={section.kind} />
												<input type="hidden" name="id" value={item.id} />
												<button
													class="border border-ink/40 px-2 py-1 font-mono text-[11px] font-bold text-coral uppercase hover:bg-coral hover:text-white"
													>Delete</button
												>
											</form>
										{/if}
									</div>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</section>

	<section class="border-t-2 border-ink py-8">
		<div class="flex items-end justify-between gap-4">
			<div>
				<p class="font-mono text-xs tracking-[0.16em] text-forest uppercase">Deterministic rules</p>
				<h2 class="mt-1 text-3xl font-semibold">Vendor aliases</h2>
			</div>
			<p class="font-mono text-xs text-ink/45">{data.rules.length} RULES</p>
		</div>

		<div class="mt-5 border-2 border-ink bg-forest p-6 text-white shadow-[7px_7px_0_#d76f51]">
			<h3 class="text-xl font-semibold">New rule</h3>
			<form method="POST" action="?/create-rule" class="mt-4 grid gap-3 md:grid-cols-2">
				<label class="block text-xs font-bold tracking-[0.12em] uppercase">
					Vendor alias (as printed on receipts)
					<input
						name="alias"
						required
						maxlength={120}
						placeholder="home depot"
						class="mt-2 w-full border-2 border-white/35 bg-white/10 px-4 py-3 text-white outline-none placeholder:text-white/35 focus:border-coral"
					/>
				</label>
				<label class="block text-xs font-bold tracking-[0.12em] uppercase">
					Canonical vendor name
					<input
						name="vendorName"
						required
						maxlength={200}
						placeholder="Home Depot"
						class="mt-2 w-full border-2 border-white/35 bg-white/10 px-4 py-3 text-white outline-none placeholder:text-white/35 focus:border-coral"
					/>
				</label>
				<label class="block text-xs font-bold tracking-[0.12em] uppercase">
					Payment account
					<select
						name="paymentAccountId"
						class="mt-2 w-full border-2 border-white/35 bg-forest px-4 py-3 text-white outline-none focus:border-coral"
					>
						<option value="">None</option>
						{#each data.paymentAccounts.filter((account) => account.active) as account (account.id)}
							<option value={account.id}>{account.name}</option>
						{/each}
					</select>
				</label>
				<label class="block text-xs font-bold tracking-[0.12em] uppercase">
					Default category
					<select
						name="categoryId"
						class="mt-2 w-full border-2 border-white/35 bg-forest px-4 py-3 text-white outline-none focus:border-coral"
					>
						<option value="">None</option>
						{#each data.categories.filter((category) => category.active) as category (category.id)}
							<option value={category.id}>{category.name}</option>
						{/each}
					</select>
				</label>
				<label class="block text-xs font-bold tracking-[0.12em] uppercase">
					Client
					<select
						name="clientId"
						class="mt-2 w-full border-2 border-white/35 bg-forest px-4 py-3 text-white outline-none focus:border-coral"
					>
						<option value="">None</option>
						{#each data.clients.filter((client) => client.active) as client (client.id)}
							<option value={client.id}>{client.name}</option>
						{/each}
					</select>
				</label>
				<div class="flex items-end">
					<button
						class="w-full bg-coral px-5 py-3.5 text-sm font-extrabold tracking-[0.1em] uppercase shadow-[4px_4px_0_#f5f1e8] hover:-translate-y-0.5"
						>Create rule</button
					>
				</div>
			</form>
		</div>

		{#if data.rules.length === 0}
			<p
				class="mt-6 border border-dashed border-ink/35 p-8 text-center font-mono text-sm text-ink/50"
			>
				NO RULES YET
			</p>
		{:else}
			<div class="mt-6 space-y-3">
				{#each data.rules as rule (rule.id)}
					<article class="border border-ink/30 bg-white/45 p-4">
						{#if editingRuleId === rule.id}
							<form method="POST" action="?/update-rule" class="grid gap-3 md:grid-cols-3">
								<input type="hidden" name="id" value={rule.id} />
								<label class="text-xs font-bold uppercase"
									>Alias
									<input
										name="alias"
										value={rule.alias}
										required
										maxlength={120}
										class="mt-1 w-full border border-ink bg-white px-3 py-2 text-sm"
									/>
								</label>
								<label class="text-xs font-bold uppercase"
									>Vendor name
									<input
										name="vendorName"
										value={rule.vendorName}
										required
										maxlength={200}
										class="mt-1 w-full border border-ink bg-white px-3 py-2 text-sm"
									/>
								</label>
								<label class="text-xs font-bold uppercase"
									>Payment account
									<select
										name="paymentAccountId"
										class="mt-1 w-full border border-ink bg-white px-3 py-2 text-sm"
									>
										<option value="">None</option>
										{#each data.paymentAccounts as account (account.id)}
											<option value={account.id} selected={account.id === rule.paymentAccountId}
												>{account.name}{account.active ? '' : ' (inactive)'}</option
											>
										{/each}
									</select>
								</label>
								<label class="text-xs font-bold uppercase"
									>Category
									<select
										name="categoryId"
										class="mt-1 w-full border border-ink bg-white px-3 py-2 text-sm"
									>
										<option value="">None</option>
										{#each data.categories as category (category.id)}
											<option value={category.id} selected={category.id === rule.categoryId}
												>{category.name}{category.active ? '' : ' (inactive)'}</option
											>
										{/each}
									</select>
								</label>
								<label class="text-xs font-bold uppercase"
									>Client
									<select
										name="clientId"
										class="mt-1 w-full border border-ink bg-white px-3 py-2 text-sm"
									>
										<option value="">None</option>
										{#each data.clients as client (client.id)}
											<option value={client.id} selected={client.id === rule.clientId}
												>{client.name}{client.active ? '' : ' (inactive)'}</option
											>
										{/each}
									</select>
								</label>
								<div class="flex items-end gap-2">
									<button
										class="border border-ink px-3 py-2 font-mono text-xs font-bold uppercase hover:bg-ink hover:text-paper"
										>Save</button
									>
									<button
										type="button"
										class="border border-ink/40 px-3 py-2 font-mono text-xs font-bold uppercase hover:bg-ink hover:text-paper"
										onclick={() => (editingRuleId = null)}>Cancel</button
									>
								</div>
							</form>
						{:else}
							<div class="flex flex-wrap items-center justify-between gap-3">
								<div class="min-w-0">
									<p class="font-semibold">
										{rule.vendorName}
										<span class="ml-2 bg-sand px-2 py-0.5 font-mono text-xs font-bold uppercase"
											>{rule.alias}</span
										>
										{#if !rule.active}
											<span class="ml-2 font-mono text-xs font-bold text-coral uppercase"
												>inactive</span
											>
										{/if}
									</p>
									<p class="mt-1 truncate font-mono text-[11px] text-ink/55 uppercase">
										{rule.paymentAccountName ?? 'no account'} · {rule.categoryName ?? 'no category'} ·
										{rule.clientName ?? 'no client'}
									</p>
								</div>
								<div class="flex gap-2">
									<button
										type="button"
										class="border border-ink/40 px-2 py-1 font-mono text-[11px] font-bold uppercase hover:bg-ink hover:text-paper"
										onclick={() => startRuleEdit(rule)}>Edit</button
									>
									<form method="POST" action="?/toggle-rule">
										<input type="hidden" name="id" value={rule.id} />
										<input type="hidden" name="active" value={rule.active ? 'false' : 'true'} />
										<button
											class="border border-ink/40 px-2 py-1 font-mono text-[11px] font-bold uppercase hover:bg-ink hover:text-paper"
											>{rule.active ? 'Deactivate' : 'Activate'}</button
										>
									</form>
									<form method="POST" action="?/delete-rule">
										<input type="hidden" name="id" value={rule.id} />
										<button
											class="border border-ink/40 px-2 py-1 font-mono text-[11px] font-bold text-coral uppercase hover:bg-coral hover:text-white"
											>Delete</button
										>
									</form>
								</div>
							</div>
						{/if}
					</article>
				{/each}
			</div>
		{/if}
	</section>
</main>
