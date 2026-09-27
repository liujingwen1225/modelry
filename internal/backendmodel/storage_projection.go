package backendmodel

import "github.com/liujingwen1225/modelry/internal/storage"

// StorageRecordProjection 暴露 Applied Collection 的存储投影，供 Drift Detection 与修复使用。
func StorageRecordProjection(collection Collection) storage.RecordCollectionProjection {
	return storageProjection(collection)
}

func storageProjection(collection Collection) storage.RecordCollectionProjection {
	projection := storage.RecordCollectionProjection{
		ID:      collection.ID,
		Fields:  make([]storage.RecordProjectionField, 0, len(collection.Fields)),
		Indexes: make([]storage.RecordProjectionIndex, 0, len(collection.Indexes)),
	}
	for _, field := range collection.Fields {
		projection.Fields = append(projection.Fields, storageFieldProjection(field))
	}
	for _, index := range collection.Indexes {
		projection.Indexes = append(projection.Indexes, storage.RecordProjectionIndex{
			ID: index.ID, Name: index.Name, Fields: append([]string(nil), index.Fields...), Unique: index.Unique,
		})
	}
	return projection
}

func storageFieldProjection(field Field) storage.RecordProjectionField {
	cardinality := ""
	if field.Relation != nil {
		cardinality = field.Relation.Cardinality
	}
	return storage.RecordProjectionField{
		ID: field.ID, Name: field.Name, Type: string(field.Type), Required: field.Required,
		Unique: field.Unique, System: field.System, Default: cloneJSON(field.Default),
		RelationCardinality: cardinality,
	}
}
