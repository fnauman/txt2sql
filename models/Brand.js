/* jshint indent: 1 */

module.exports = function(sequelize, DataTypes) {
	// Brand: synthetic product brand master.
	const Brand = sequelize.define('Brand', {
		BrandId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			primaryKey: true,
			autoIncrement: true,
			comment: 'Primary key for the brand.'
		},
		BrandCode: {
			type: DataTypes.STRING(20),
			allowNull: true,
			unique: true,
			comment: 'Synthetic brand code.'
		},
		BrandName: {
			type: DataTypes.STRING(100),
			allowNull: true,
			comment: 'Synthetic brand display name.'
		},
		ProductCategoryId: {
			type: DataTypes.INTEGER(10),
			allowNull: true,
			references: { model: 'ProductCategory', key: 'ProductCategoryId' },
			comment: 'Default category associated with this brand.'
		}
	}, {
		tableName: 'Brand',
		timestamps: false,
		freezeTableName: true
	});

	Brand.associate = (models) => {
		Brand.belongsTo(models.ProductCategory, { foreignKey: 'ProductCategoryId', as: 'ProductCategory' });
		Brand.hasMany(models.Product, { foreignKey: 'BrandId', as: 'Products' });
		Brand.hasMany(models.ProductBrand, { foreignKey: 'BrandId', as: 'ProductBrands' });
	};

	return Brand;
};
