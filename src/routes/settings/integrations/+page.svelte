<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>AI classification | Expensifier</title>
	<meta name="description" content="Inspect Expensifier AI classification configuration." />
</svelte:head>

<main class="mx-auto min-h-screen max-w-5xl px-5 py-6 sm:px-8 sm:py-10">
	<header class="border-b-2 border-ink pb-7">
		<a
			href="/settings"
			class="font-mono text-xs font-bold tracking-[0.18em] text-forest uppercase hover:text-coral"
		>
			← Settings
		</a>
		<h1 class="mt-3 text-4xl font-semibold tracking-[-0.045em] sm:text-6xl">AI classification.</h1>
		<p class="mt-3 max-w-2xl text-ink/65">
			Provider credentials stay in environment variables. This screen deliberately exposes no secret
			values.
		</p>
	</header>

	<section class="grid gap-6 py-8 md:grid-cols-[0.8fr_1.2fr]">
		<div class="border-2 border-ink bg-forest p-6 text-white shadow-[7px_7px_0_#d76f51]">
			<p class="font-mono text-xs font-bold tracking-[0.16em] text-white/55 uppercase">
				Selected provider
			</p>
			<h2 class="mt-3 text-3xl font-semibold">{data.classification.provider}</h2>
			<dl class="mt-6 space-y-4 font-mono text-xs">
				<div>
					<dt class="text-white/50 uppercase">Model</dt>
					<dd class="mt-1">{data.classification.model}</dd>
				</div>
				<div>
					<dt class="text-white/50 uppercase">Endpoint host</dt>
					<dd class="mt-1">{data.classification.endpointHost}</dd>
				</div>
				<div>
					<dt class="text-white/50 uppercase">Timeout</dt>
					<dd class="mt-1">{data.classification.timeoutMilliseconds} ms</dd>
				</div>
			</dl>
			<p
				class={`mt-7 inline-block px-3 py-2 font-mono text-xs font-bold uppercase ${data.classification.configured ? 'bg-emerald-200 text-forest' : 'bg-amber-200 text-ink'}`}
			>
				{data.classification.configured ? 'Credentials configured' : 'Credentials missing'}
			</p>
		</div>

		<div class="border-2 border-ink bg-white/45 p-6">
			<p class="font-mono text-xs font-bold tracking-[0.16em] text-forest uppercase">
				Hard boundary
			</p>
			<h2 class="mt-2 text-2xl font-semibold">Structured OCR only.</h2>
			<ul class="mt-5 space-y-3 text-sm leading-6 text-ink/70">
				<li class="border-t border-ink/20 pt-3">No receipt file, filename, or managed path.</li>
				<li class="border-t border-ink/20 pt-3">
					No raw OCR provider response or unrestricted OCR text.
				</li>
				<li class="border-t border-ink/20 pt-3">
					Only normalized field values/confidence and active candidate IDs/names.
				</li>
				<li class="border-t border-ink/20 pt-3">
					Every suggestion and reviewer outcome is stored and audited locally.
				</li>
			</ul>
			<a
				href="https://github.com/openai/openai-openapi"
				class="mt-6 inline-block font-mono text-xs font-bold text-forest uppercase hover:text-coral"
				>Provider API reference →</a
			>
		</div>
	</section>
</main>
