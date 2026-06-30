/* jshint indent: 1 */

module.exports = function(sequelize, DataTypes) {
	// SalesDocumentLine: synthetic line-level product sales fact.
	const SalesDocumentLine = sequelize.define('SalesDocumentLine', {
		SalesDocumentLineId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			primaryKey: true,
			autoIncrement: true,
			comment: 'Primary key for the sales document line.'
		},
		SalesDocumentId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			references: { model: 'SalesDocument', key: 'SalesDocumentId' },
			comment: 'Parent sales document header.'
		},
		ProductId: {
			type: DataTypes.INTEGER(10),
			allowNull: true,
			references: { model: 'Product', key: 'ProductId' },
			comment: 'Product sold on this line.'
		},
		ProductNameSnapshot: {
			type: DataTypes.STRING(160),
			allowNull: true,
			comment: 'Line-level product name snapshot.'
		},
		Quantity: {
			type: DataTypes.DECIMAL,
			allowNull: true,
			defaultValue: '0.0000',
			comment: 'Quantity sold on this line.'
		},
		SalePrice: {
			type: DataTypes.DECIMAL,
			allowNull: true,
			defaultValue: '0.0000',
			comment: 'Unit sale price for this line.'
		},
		TotalAmount: {
			type: DataTypes.DECIMAL,
			allowNull: true,
			defaultValue: '0.0000',
			comment: 'Total line amount before final adjustments.'
		},
		NetAmount: {
			type: DataTypes.DECIMAL,
			allowNull: true,
			defaultValue: '0.0000',
			comment: 'Preferred line-level net sales amount.'
		},
		CategoryNameSnapshot: {
			type: DataTypes.STRING(120),
			allowNull: true,
			comment: 'Stale category name snapshot retained for guardrail examples.'
		},
		BrandNameSnapshot: {
			type: DataTypes.STRING(100),
			allowNull: true,
			comment: 'Stale brand name snapshot retained for guardrail examples.'
		}
	}, {
		tableName: 'SalesDocumentLine',
		timestamps: false,
		freezeTableName: true
	});

	SalesDocumentLine.associate = (models) => {
		SalesDocumentLine.belongsTo(models.SalesDocument, { foreignKey: 'SalesDocumentId', as: 'SalesDocument' });
		SalesDocumentLine.belongsTo(models.Product, { foreignKey: 'ProductId', as: 'Product' });
	};

	return SalesDocumentLine;
};
