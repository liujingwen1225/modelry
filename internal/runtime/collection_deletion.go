package runtime

import (
	"context"

	"github.com/liujingwen1225/modelry/internal/filestore"
	"github.com/liujingwen1225/modelry/internal/records"
)

// collectionFileCleaner 把「集合删除」与文件存储解耦。
// 集合删除事务提交后，只清理已不再被任何集合引用的对象；
// 仍被引用的对象（例如用户手工复制了同一个文件引用）必须保留。
type collectionFileCleaner struct {
	files   *filestore.Service
	records *records.Service
}

func (cleaner collectionFileCleaner) DeleteUnreferenced(ctx context.Context, keys []string) (int, error) {
	if len(keys) == 0 {
		return 0, nil
	}
	referenced, err := cleaner.records.ReferencedFileKeys(ctx)
	if err != nil {
		return 0, err
	}
	stillUsed := make(map[string]struct{}, len(referenced))
	for _, key := range referenced {
		stillUsed[key] = struct{}{}
	}
	provider, err := cleaner.files.ActiveProvider(ctx)
	if err != nil {
		return 0, err
	}
	deleted := 0
	for _, key := range keys {
		if _, used := stillUsed[key]; used {
			continue
		}
		if err := provider.Delete(ctx, key); err != nil {
			return deleted, err
		}
		deleted++
	}
	return deleted, nil
}
