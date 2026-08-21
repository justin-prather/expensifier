import { Context, Effect, Layer } from 'effect';

export interface ApprovedExpenseSummary {
	readonly expenseId: string;
	readonly documentId: string;
	readonly vendor: string;
	readonly transactionDate: string;
	readonly totalMinor: number;
	readonly currency: string;
	readonly managedPath: string;
}

export class ApprovalIntegrationService extends Context.Service<
	ApprovalIntegrationService,
	{
		readonly notifyApproved: (expense: ApprovedExpenseSummary) => Effect.Effect<void>;
	}
>()('expensifier/ApprovalIntegrationService') {
	static readonly layer = Layer.succeed(
		ApprovalIntegrationService,
		ApprovalIntegrationService.of({
			notifyApproved: () => Effect.void
		})
	);
}
