<script lang="ts">
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	function invitationStatus(invitation: PageData['invitations'][number]) {
		if (invitation.acceptedAt) return 'accepted';
		if (invitation.revokedAt) return 'revoked';
		if (new Date(invitation.expiresAt).getTime() <= Date.now()) return 'expired';
		return 'pending';
	}
</script>

<svelte:head>
	<title>Users and invitations | Expensifier</title>
	<meta name="description" content="Manage Expensifier users, roles, and invitation links." />
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
			<h1 class="mt-3 text-4xl font-semibold tracking-[-0.045em] sm:text-6xl">
				People with the keys.
			</h1>
			<p class="mt-3 max-w-2xl text-ink/65">
				Create one-time links, assign access, and inspect who can enter the ledger.
			</p>
		</div>
		<p class="font-mono text-xs font-bold tracking-[0.2em] text-forest uppercase">Admin settings</p>
	</header>

	{#if form?.message}
		<div class="mt-6 border-l-4 border-coral bg-white/55 px-4 py-3 text-sm font-semibold">
			{form.message}
		</div>
	{/if}

	<section class="grid gap-8 py-8 lg:grid-cols-[0.8fr_1.2fr]">
		<div class="border-2 border-ink bg-forest p-6 text-white shadow-[7px_7px_0_#d76f51] sm:p-8">
			<p class="font-mono text-xs font-bold tracking-[0.18em] text-white/55 uppercase">
				New invitation
			</p>
			<h2 class="mt-3 text-3xl font-semibold tracking-tight">Issue a temporary key.</h2>
			<p class="mt-3 text-sm leading-6 text-white/65">
				Links expire after 72 hours and can be used once. The token is shown only when created.
			</p>

			<form method="POST" action="?/invite" class="mt-8 space-y-5">
				<label class="block">
					<span class="text-xs font-bold tracking-[0.12em] uppercase">Email</span>
					<input
						name="email"
						type="email"
						autocomplete="off"
						required
						value={form?.action === 'invite' && 'email' in form ? form.email : ''}
						class="mt-2 w-full border-2 border-white/35 bg-white/10 px-4 py-3 text-white outline-none placeholder:text-white/35 focus:border-coral"
						placeholder="accountant@example.com"
					/>
				</label>
				<label class="block">
					<span class="text-xs font-bold tracking-[0.12em] uppercase">Role</span>
					<select
						name="role"
						class="mt-2 w-full border-2 border-white/35 bg-forest px-4 py-3 text-white outline-none focus:border-coral"
					>
						<option value="accountant">Accountant</option>
						<option value="admin">Admin</option>
					</select>
				</label>
				<button
					class="w-full bg-coral px-5 py-4 text-sm font-extrabold tracking-[0.1em] uppercase shadow-[4px_4px_0_#f5f1e8] hover:-translate-y-0.5"
					>Create invitation</button
				>
			</form>

			{#if form?.invitationUrl}
				<div class="mt-7 border border-white/30 bg-black/15 p-4">
					<p class="font-mono text-[11px] font-bold tracking-[0.15em] text-white/55 uppercase">
						Copy this link now
					</p>
					<input
						readonly
						value={form.invitationUrl}
						onfocus={(event) => event.currentTarget.select()}
						class="mt-2 w-full bg-transparent font-mono text-xs text-white outline-none"
					/>
				</div>
			{/if}
		</div>

		<div class="border-2 border-ink bg-paper">
			<div class="flex items-center justify-between border-b-2 border-ink p-5">
				<div>
					<p class="font-mono text-xs tracking-[0.16em] uppercase">Active accounts</p>
					<h2 class="mt-1 text-2xl font-semibold">Users</h2>
				</div>
				<span
					class="grid size-10 place-items-center rounded-full bg-ink font-mono text-sm font-bold text-paper"
					>{data.users.length}</span
				>
			</div>
			<div class="divide-y divide-ink/20">
				{#each data.users as user (user.id)}
					<article class="grid gap-4 p-5 sm:grid-cols-[1fr_auto] sm:items-center">
						<div class="min-w-0">
							<p class="font-semibold">{user.name}</p>
							<p class="truncate text-sm text-ink/55">{user.email}</p>
						</div>
						<form method="POST" action="?/set-role" class="flex items-center gap-2">
							<input type="hidden" name="userId" value={user.id} />
							<select
								name="role"
								value={user.role ?? 'accountant'}
								class="border border-ink/30 bg-paper px-3 py-2 font-mono text-xs font-bold uppercase"
							>
								<option value="accountant">Accountant</option>
								<option value="admin">Admin</option>
							</select>
							<button
								class="border border-ink px-3 py-2 text-xs font-extrabold tracking-wide uppercase hover:bg-ink hover:text-paper"
								>Save</button
							>
						</form>
					</article>
				{/each}
			</div>
		</div>
	</section>

	<section class="border-t-2 border-ink py-8">
		<div class="flex items-end justify-between gap-4">
			<div>
				<p class="font-mono text-xs tracking-[0.16em] text-forest uppercase">Access ledger</p>
				<h2 class="mt-1 text-3xl font-semibold">Invitations</h2>
			</div>
			<p class="font-mono text-xs text-ink/45">{data.invitations.length} TOTAL</p>
		</div>
		{#if data.invitations.length === 0}
			<p
				class="mt-6 border border-dashed border-ink/35 p-8 text-center font-mono text-sm text-ink/50"
			>
				NO INVITATIONS YET
			</p>
		{:else}
			<div class="mt-5 overflow-x-auto border-2 border-ink bg-white/35">
				<table class="w-full min-w-3xl border-collapse text-left text-sm">
					<thead class="bg-sand/65 font-mono text-xs tracking-wide uppercase">
						<tr
							><th class="p-4">Recipient</th><th class="p-4">Role</th><th class="p-4">Expires</th
							><th class="p-4">Status</th><th class="p-4"><span class="sr-only">Actions</span></th
							></tr
						>
					</thead>
					<tbody class="divide-y divide-ink/15">
						{#each data.invitations as invitation (invitation.id)}
							<tr>
								<td class="p-4 font-semibold">{invitation.email}</td>
								<td class="p-4 font-mono text-xs uppercase">{invitation.role}</td>
								<td class="p-4 text-ink/60">{new Date(invitation.expiresAt).toLocaleString()}</td>
								<td class="p-4"
									><span class="bg-sand px-2 py-1 font-mono text-xs font-bold uppercase"
										>{invitationStatus(invitation)}</span
									></td
								>
								<td class="p-4 text-right">
									{#if invitationStatus(invitation) === 'pending'}
										<form method="POST" action="?/revoke">
											<input type="hidden" name="invitationId" value={invitation.id} /><button
												class="text-xs font-extrabold tracking-wide text-coral uppercase hover:underline"
												>Revoke</button
											>
										</form>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</main>
