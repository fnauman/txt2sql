/* jshint indent: 1 */

module.exports = function(sequelize, DataTypes) {
	// ProductBrand: optional bridge table for product-brand assignments.
	const ProductBrand = sequelize.define('ProductBrand', {
		ProductBrandId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			primaryKey: true,
			autoIncrement: true,
			comment: 'Primary key for the product-brand bridge row.'
		},
		ProductId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			references: { model: 'Product', key: 'ProductId' },
			comment: 'Product in the bridge assignment.'
		},
		BrandId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			references: { model: 'Brand', key: 'BrandId' },
			comment: 'Brand in the bridge assignment.'
		}
	}, {
		tableName: 'ProductBrand',
		timestamps: false,
		freezeTableName: true
	});

	ProductBrand.associate = (models) => {
		ProductBrand.belongsTo(models.Product, { foreignKey: 'ProductId', as: 'Product' });
		ProductBrand.belongsTo(models.Brand, { foreignKey: 'BrandId', as: 'Brand' });
	};

	return ProductBrand;
};
