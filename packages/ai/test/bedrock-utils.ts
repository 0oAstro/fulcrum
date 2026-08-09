import { getAwsProfileConfig } from "../src/env-api-keys.js";

/**
 * Check if any valid AWS credential source is configured for Bedrock.
 * This is an availability hint; the AWS SDK validates and refreshes the
 * source when a request is sent.
 */
export function hasBedrockCredentials(): boolean {
	return !!(
		process.env.AWS_PROFILE ||
		(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
		process.env.AWS_BEARER_TOKEN_BEDROCK ||
		getAwsProfileConfig()?.hasCredentialSource
	);
}
