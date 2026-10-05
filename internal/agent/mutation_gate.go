package agent

import "context"

// MutationGate 串行化目标复核与业务写入，等待时仍可取消任务。
type MutationGate struct{ token chan struct{} }

func NewMutationGate() *MutationGate { return &MutationGate{token: make(chan struct{}, 1)} }
func (g *MutationGate) Lock(ctx context.Context) error {
	select {
	case g.token <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (g *MutationGate) Unlock() { <-g.token }
