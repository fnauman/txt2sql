/* jshint indent: 1 */

module.exports = function(sequelize, DataTypes) {
	// Product: synthetic product/SKU master.
	const Product = sequelize.define('Product', {
		ProductId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			primaryKey: true,
			autoIncrement: true,
			comment: 'Primary key for the product.'
		},
		ProductCode: {
			type: DataTypes.STRING(30),
			allowNull: true,
			unique: true,
			comment: 'Synthetic product code or SKU.'
		},
		ProductName: {
			type: DataTypes.STRING(160),
			allowNull: true,
			comment: 'Synthetic product display name.'
		},
		ProductTags: {
			type: DataTypes.STRING(200),
			allowNull: true,
			comment: 'Synthetic search aliases for product resolution.'
		},
		ProductCategoryId: {
			type: DataTypes.INTEGER(10),
			allowNull: true,
			references: { model: 'ProductCategory', key: 'ProductCategoryId' },
			comment: 'Current product category.'
		},
		BrandId: {
			type: DataTypes.INTEGER(10),
			allowNull: true,
			references: { model: 'Brand', key: 'BrandId' },
			comment: 'Current product brand.'
		},
		CampaignId: {
			type: DataTypes.INTEGER(10),
			allowNull: true,
			references: { model: 'Campaign', key: 'CampaignId' },
			comment: 'Campaign or program associated with this product.'
		},
		IsActive: {
			type: DataTypes.INTEGER(1),
			allowNull: false,
			defaultValue: '1',
			comment: 'Whether the synthetic product is active.'
		}
	}, {
		tableName: 'Product',
		timestamps: false,
		freezeTableName: true
	});

	Product.associate = (models) => {
		Product.belongsTo(models.ProductCategory, { foreignKey: 'ProductCategoryId', as: 'ProductCategory' });
		Product.belongsTo(models.Brand, { foreignKey: 'BrandId', as: 'Brand' });
		Product.belongsTo(models.Campaign, { foreignKey: 'CampaignId', as: 'Campaign' });
		Product.hasMany(models.SalesDocumentLine, { foreignKey: 'ProductId', as: 'SalesDocumentLines' });
		Product.hasMany(models.CustomerProductPrice, { foreignKey: 'ProductId', as: 'CustomerProductPrices' });
		Product.hasMany(models.ProductBrand, { foreignKey: 'ProductId', as: 'ProductBrands' });
	};

	return Product;
};
