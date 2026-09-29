//go:build !linux

package editor

import "context"

// queryNativeCompletion leaves native queries unavailable on unsupported remote platforms.
func queryNativeCompletion(_ context.Context, _ Target, _ Snapshot, _ []string) NativeCompletionResult {
	return completionFailure("unavailable")
}
